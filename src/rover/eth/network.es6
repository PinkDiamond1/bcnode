/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
import type { RoverMessage } from '../../protos/rover_pb'

const assert = require('assert')
const EventEmitter = require('events')
const { DPT, RLPx, ETH, _util } = require('ethereumjs-devp2p')
const { default: EthereumCommon } = require('ethereumjs-common')
const EthereumBlock = require('ethereumjs-block')
const EthereumTx = require('ethereumjs-tx')
const LRUCache = require('lru-cache')
const portscanner = require('portscanner')
const { promisify } = require('util')
const rlp = require('rlp-encoding')
const fs = require('fs')
const BN = require('bn.js')
const {
  aperture,
  contains,
  drop,
  head,
  init,
  isEmpty,
  last,
  map,
  pathOr,
  range,
  reverse,
  splitEvery,
  sort,
  take,
  without
} = require('ramda')

const logging = require('../../logger')
const { getPrivateKey } = require('../utils')
const { config } = require('../../config')
const { ROVER_RESYNC_PERIOD, ROVER_SECONDS_PER_BLOCK } = require('../utils')
const { rangeStep } = require('../../utils/ramda')
const { Block } = require('../../protos/core_pb')

const BC_NETWORK = process.env.BC_NETWORK || 'main'
const chainName = (true || BC_NETWORK === 'main') // eslint-disable-line
  ? 'mainnet'
  : 'ropsten'
const ec = new EthereumCommon(chainName)

const ETH_MAX_FETCH_BLOCKS = 128
const MAX_INVALID_COUNT = 8
const BOOTNODES = ec.bootstrapNodes().map(node => {
  return {
    address: node.ip,
    udpPort: node.port,
    tcpPort: node.port
  }
}).concat(config.rovers.eth.altBootNodes).map((node) => {
  if (node.tcpPort === undefined) {
    node.tcpPort = node.udpPort
  }
  return node
})

// const BOOTNODES = shuffle(BOOTNODES_ORDERED)

const DAO_FORK_SUPPORT = true
let ws = false

const DISCONNECT_REASONS = Object.keys(RLPx.DISCONNECT_REASONS)
  .reduce((acc, key) => {
    const errorKey = parseInt(RLPx.DISCONNECT_REASONS[key], 10)
    acc[errorKey] = key
    return acc
  }, {})

const HOSTS = BOOTNODES.map((b) => {
  return b.address
})

if (process.env.BC_ROVER_DEBUG_ETH !== undefined) {
  ws = fs.createWriteStream('eth_peer_errors.csv')
}

// TODO extract this to config
const ETH_1920000_HEADER = rlp.decode(
  Buffer.from(
    'f9020da0a218e2c611f21232d857e3c8cecdcdf1f65f25a4477f98f6f47e4063807f2308a01dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d4934794bcdfc35b86bedf72f0cda046a3c16829a2ef41d1a0c5e389416116e3696cce82ec4533cce33efccb24ce245ae9546a4b8f0d5e9a75a07701df8e07169452554d14aadd7bfa256d4a1d0355c1d174ab373e3e2d0a3743a026cf9d9422e9dd95aedc7914db690b92bab6902f5221d62694a2fa5d065f534bb90100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008638c3bf2616aa831d4c008347e7c08301482084578f7aa88d64616f2d686172642d666f726ba05b5acbf4bf305f948bd7be176047b20623e1417f75597341a059729165b9239788bede87201de42426',
    'hex'
  )
)
const ETH_1920000 = '4985f5ca3d2afbec36529aa96f74de3cc10a2a4a6c44f2157a57d2c6059a11bb'
const ETC_1920000 = '94365e3a8c0b35089c1d1195081fe7489b528a84b22199c916180db8b28ade7f'
// TODO end extract this to config
const findAPortNotInUse = promisify(portscanner.findAPortNotInUse)

const getPeerAddr = peer => `${peer._socket.remoteAddress}:${peer._socket.remotePort}`

const isValidTx = (tx: EthereumTx) => tx.validate(false)

const isValidBlock = (block: EthereumBlock) => {
  if (!block.validateUnclesHash()) {
    return Promise.resolve(false)
  }

  if (!block.transactions.every(isValidTx)) {
    return Promise.resolve(false)
  }

  return new Promise((resolve, reject) => {
    block.genTxTrie(() => {
      try {
        resolve(block.validateTransactionsTrie())
      } catch (err) {
        reject(err)
      }
    })
  })
}

const randomChoiceMut = (arr: Array<any>) => {
  const index = Math.floor(Math.random() * arr.length)
  const ret = arr[index]
  arr.splice(index, 1)
  return ret
}

type PeerRequests = {
  [address: string]: {
    hashes: string[],
    headers: EthereumBlock.Header[]
  }
}

export default class Network extends EventEmitter {
  _key: Buffer
  _logger: Object
  _minimumPeers: number
  _peers: string[]
  _dpt: ?DPT
  _rlpx: ?RLPx
  _txCache: LRUCache<string, bool>
  _blocksCache: LRUCache<string, bool>
  _forkDrops: {[string]: ?TimeoutID}
  _forkVerifiedForPeer: Object
  _peerRequests: PeerRequests
  _config: { maximumPeers: number }
  _maximumPeers: number
  _requestedBlocks: number[]
  _initialSyncBlocksToFetch: [number, number][]
  _initialResync: boolean
  _resyncData: ?RoverMessage.Resync
  _bestSeenBlock: ?EthereumBlock
  _invalidDifficultyCount: number
  _syncCheckTimeout: IntervalID

  constructor (config: { maximumPeers: number }) {
    super()
    this._logger = logging.getLogger(__filename)
    this._forkVerifiedForPeer = {}
    this._forkDrops = {}
    this._peerRequests = {}
    this._minimumPeers = 12
    this._peers = []
    this._rlpx = null
    this._key = getPrivateKey()
    this._txCache = new LRUCache({ max: 2000 })
    this._blocksCache = new LRUCache({ max: 118 })
    this._config = config
    this._maximumPeers = this._config.maximumPeers + (Math.floor(Math.random() * 18) - 9) // add variability to peer pool on boot
    this._requestedBlocks = []
    this._initialSyncBlocksToFetch = []
    this._initialResync = false
    this._invalidDifficultyCount = 0

    this._syncCheckTimeout = setInterval(() => {
      this._logger.info(`Checking initial sync - possibly scheduling next batch (${this._initialSyncBlocksToFetch.length} intervals remaining)`)
      if (isEmpty(this._requestedBlocks) && !isEmpty(this._initialSyncBlocksToFetch)) {
        const batch = head(take(1, this._initialSyncBlocksToFetch))
        this._initialSyncBlocksToFetch = drop(1, this._initialSyncBlocksToFetch)
        if (!batch) {
          this._logger.warn(`Empty intervals to request: ${JSON.stringify(this._initialSyncBlocksToFetch)}`)
          return
        }
        this._logger.info(`Scheduling batch ${batch}, length: ${batch[0] - batch[batch.length - 1]}`)
        this.requestBlockRange(batch)
      }
    }, 10000)

  }

  get peers (): string[] {
    return this._peers
  }

  get rlpx (): RLPx {
    return this._rlpx
  }

  get initialResync (): boolean {
    this._logger.debug(`InitialResync getter called with ${String(this._initialResync)}`)
    return this._initialResync
  }

  set initialResync (status: boolean) {
    this._logger.debug(`InitialResync setter called with ${String(status)}`)
    this._initialResync = status
  }

  get resyncData (): RoverMessage.Resync {
    return this._resyncData
  }

  set resyncData (data: RoverMessage.Resync) {
    this._resyncData = data
  }

  addPeer (peer: Object) {
    if (!peer || !peer.endpoint) {
      return
    }

    const host = peer.endpoint.address
    const protocol = 'http'

    if (HOSTS.indexOf(host) > -1) {
      return
    }

    if (peer.endpoint.tcpPort) {
      const port = peer.endpoint.tcpPort
      const target = `${protocol}://${host}:${port}`

      this._logger.debug('New peer: ' + target)
      this.peers.push(target)
    }
  }

  connect () {
    findAPortNotInUse(30304, 33663)
      .then((port) => {
        this.run(port)
      })
      .catch(() => {
        this._logger.error('Unable to find local network interface to listen on')
        process.exit(3)
      })
  }

  onNewTx (tx: EthereumTx, peer: Object) {
    const txHashHex = tx.hash().toString('hex')
    if (this._txCache.has(txHashHex)) {
      return
    }

    this._txCache.set(txHashHex, true)
    // this._logger.debug(`new tx: ${txHashHex} (from ${getPeerAddr(peer)})`)
  }

  onNewBlock (block: EthereumBlock, peer: Object, isBlockFromInitialSync: boolean) {
    const blockHashHex = block.hash().toString('hex')
    if (this._blocksCache.has(blockHashHex)) {
      return
    }

    this._blocksCache.set(blockHashHex, true)

    for (let tx of block.transactions) {
      this.onNewTx(tx, peer)
    }

    const blockNumber = new BN(block.header.number).toNumber()
    const bestBlockNumber = parseInt(pathOr(Buffer.from('00', 'hex'), ['header', 'number'], this._bestSeenBlock).toString('hex'), 16)
    this._logger.debug(`Best block known: ${bestBlockNumber}`) // NOTE: initial sync debug -> info
    this._logger.info(`Transmitting new block ${blockHashHex} with height: ${blockNumber} from peer "${getPeerAddr(peer)}"`)
    // difficulty check
    if (this._bestSeenBlock && !isBlockFromInitialSync) {
      const difficultyValid = block.header.validateDifficulty(this._bestSeenBlock)
      const possiblyConsecutiveBlock = bestBlockNumber < blockNumber
      if (!difficultyValid && !possiblyConsecutiveBlock) {
        this._invalidDifficultyCount++
        const blockInfo = {
          parentBlock: {
            'height': bestBlockNumber,
            'difficulty': parseInt(pathOr(Buffer.from('00', 'hex'), ['header', 'difficulty'], this._bestSeenBlock).toString('hex'), 16)
          },
          newBlock: {
            'height': (new BN(block.header.number)).toString(),
            'difficulty': (new BN(block.header.difficulty)).toString()
          }
        }
        this._logger.warn(`Incoming block has invalid difficulty - rejecting the block and disconnecting peer, info: ${JSON.stringify(blockInfo)}`)
        if (this._invalidDifficultyCount > MAX_INVALID_COUNT) {
          this._logger.warn(`Maximum amount of invalid ETH blocks reached - restarting rover to try to connect to valid peers`)
          // TODO when disconnecting peer - we have to request all the headers + blocks which can possibly be in the _requestedBlocks again from another one
          peer && peer.disconnect && peer.disconnect(RLPx.DISCONNECT_REASONS.USELESS_PEER)
        }
        return
      }

      if (possiblyConsecutiveBlock) {
        // request missing blocks
        this.request(this._bestSeenBlock, block);
      }
      this._invalidDifficultyCount = 0
      this._logger.debug(`Block's ${parseInt(block.header.number.toString('hex'), 16)} difficulty is valid -> creating unified block from it`)
    }

    if (!isBlockFromInitialSync) {
      this._bestSeenBlock = block
    }

    this.emit('newBlock', { block, isBlockFromInitialSync })
  }

  requestBlock (fromBlock: Block, toBlock: Block) {
    const peers = [].concat(Object.values(this._forkVerifiedForPeer))

    // select random floor(maximumPeers / 3)
    const askPeers = []
    const numChosen = Math.floor(peers.length)
    for (var i = 0; i < numChosen; i++) {
      askPeers.push(randomChoiceMut(peers))
    }

    const blockNumbersToRequest = range(fromBlock.getHeight() + 1, toBlock.getHeight())
    if (blockNumbersToRequest.length > ETH_MAX_FETCH_BLOCKS) {
      this._logger.info(`Requested ${blockNumbersToRequest.length} (more than ${ETH_MAX_FETCH_BLOCKS}) to be fetched either node is starting or very stale / different eth chain BC block received, giving up`)
      return
    }
    this._logger.debug(`blockNumbersToRequest: ${blockNumbersToRequest[0]} - ${blockNumbersToRequest[blockNumbersToRequest.length - 1]} from ${askPeers.length} peers`)
    this._requestedBlocks = this._requestedBlocks.concat(blockNumbersToRequest)

    if (askPeers.length >= 2) {
      for (const peer of askPeers) {
        this._logger.debug(`Requested blocks ${blockNumbersToRequest} to be fetched from ${getPeerAddr(peer)}`)
        const eth = peer.getProtocols()[0]
        blockNumbersToRequest.map(blockNumber => {
          eth.sendMessage(ETH.MESSAGE_CODES.GET_BLOCK_HEADERS, [
            blockNumber, // block number of first block requested
            1, // count of blocks we want to get
            0,
            0
          ])
        })
      }
    } else {
      this._logger.debug(`Could not request blocks ${blockNumbersToRequest}, waiting for peers (have ${askPeers.length} currently)`)
    }
  }

  scheduleInitialSync (knownBlock: number) {
    let blockIntervalsToRequest: [number, number][]
    if (!isEmpty(this.resyncData.getIntervalsList())) {
      // sort intervals in reverse order
      const sortedIntervals = sort(
        (a, b) => b.getFromBlock() - a.getFromBlock(),
        this.resyncData.getIntervalsList()
      )
      blockIntervalsToRequest = []
      for (const interval of sortedIntervals) {
        // if intervals spans more than ETH_MAX_FETCH_BLOCKS
        if (interval.getToBlock() - interval.getFromBlock() > ETH_MAX_FETCH_BLOCKS) {
          const tempIntervals = aperture(2, reverse(rangeStep(interval.getFromBlock(), ETH_MAX_FETCH_BLOCKS, interval.getToBlock()).concat(interval.getToBlock())))
          blockIntervalsToRequest = blockIntervalsToRequest.concat(
            init(tempIntervals).map(([from, to]) => ([from, to + 1]))
          )
          blockIntervalsToRequest.push(last(tempIntervals))
        } else {
          blockIntervalsToRequest.push([interval.getToBlock(), interval.getFromBlock()])
        }
      }
      const knownLatestBlock = this.resyncData.getLatestBlock()
      if (
        knownLatestBlock &&
        Date.now() - knownLatestBlock.getTimestamp() > ROVER_SECONDS_PER_BLOCK['lsk']
      ) {
        const knownLatestBlockHeight = knownLatestBlock.getHeight()
        const latestIntervals = []
        if (knownBlock - knownLatestBlockHeight > ETH_MAX_FETCH_BLOCKS) {
          const tempIntervals = aperture(2, reverse(rangeStep(knownLatestBlockHeight, ETH_MAX_FETCH_BLOCKS, knownBlock).concat(knownBlock)))
          blockIntervalsToRequest = [last(tempIntervals)].concat(blockIntervalsToRequest)
          blockIntervalsToRequest = init(tempIntervals).map(
            ([from, to]) => ([from, to + 1])
          ).concat(blockIntervalsToRequest)
        } else {
          blockIntervalsToRequest = [[knownBlock, knownLatestBlockHeight]].concat(blockIntervalsToRequest)
        }
        blockIntervalsToRequest = latestIntervals.concat(blockIntervalsToRequest)
      }
    } else {
      const count = ROVER_RESYNC_PERIOD / ROVER_SECONDS_PER_BLOCK['eth']
      const from = Math.max(0, knownBlock - count + 1)
      const to = knownBlock
      blockIntervalsToRequest = map(
        interval => [interval[0], interval[interval.length - 1]],
        splitEvery(
          ETH_MAX_FETCH_BLOCKS,
          reverse(range(from, to + 1))
        )
      )
      this._logger.debug(`blockIntervalsToRequest: ${from} - ${to}`)
    }
    this._logger.debug(`blockIntervalsToRequest: ${JSON.stringify(blockIntervalsToRequest)}`)
    this._initialSyncBlocksToFetch = drop(1, blockIntervalsToRequest)
    const firstBatch = head(take(1, blockIntervalsToRequest))
    if (!firstBatch) {
      this._logger.warn(`Empty intervals to request: ${JSON.stringify(blockIntervalsToRequest)}`)
      return
    }
    this.requestBlockRange(firstBatch)
  }

  requestBlockRange ([to, from]: [number, number]) {
    const peers = [].concat(Object.values(this._forkVerifiedForPeer))
    const WAIT_FOR_PEERS = 2
    const WAIT_FOR_PEERS_TIMEOUT = 10000

    if (peers.length < WAIT_FOR_PEERS) {
      this._logger.debug(`Peer count ${peers.length} < ${WAIT_FOR_PEERS} - postponing inital resync by ${WAIT_FOR_PEERS_TIMEOUT / 1000}s.`) // NOTE: initial sync debug -> info
      setTimeout(() => {
        this.requestBlockRange([to, from])
      }, WAIT_FOR_PEERS_TIMEOUT)
      return
    }

    this._requestedBlocks = this._requestedBlocks.concat(range(from, to + 1))

    // select random floor(maximumPeers / 3)
    const askPeers = []
    const numChosen = Math.floor(peers.length)
    for (var i = 0; i < numChosen; i++) {
      askPeers.push(randomChoiceMut(peers))
    }

    const count = to - from + 1
    this._logger.info(`requesting ${count} blocks (${from} - ${to}) from ${askPeers.length} peers`)

    for (const peer of askPeers) {
      const eth = peer.getProtocols()[0]
      eth.sendMessage(ETH.MESSAGE_CODES.GET_BLOCK_HEADERS, [
        from, // block number of last block requested
        count, // count of blocks we want to get
        0,
        0
      ])
    }
  }

  handleMessage (rlpx: Object, code: string, payload: Buffer, peer: Object) {
    // this._logger.debug(`new message, code: ${code}`)
    // console.log('message.payload', payload)
    // console.log(`new message (${addr}) ${code} ${rlp.encode(payload).toString('hex')}`)

    switch (code) {
      case ETH.MESSAGE_CODES.BLOCK_BODIES:
        this.handleMessageBlockBodies(payload, peer)
        break

      case ETH.MESSAGE_CODES.BLOCK_HEADERS:
        this.handleMessageBlockHeaders(payload, peer)
        break

      case ETH.MESSAGE_CODES.GET_BLOCK_BODIES:
        this.handleMessageGetBlockBodies(peer)
        break

      case ETH.MESSAGE_CODES.GET_BLOCK_HEADERS:
        this.handleMessageGetBlockHeaders(payload, peer)
        break

      case ETH.MESSAGE_CODES.GET_NODE_DATA:
        this.handleMessageGetNodeData(peer)
        break

      case ETH.MESSAGE_CODES.GET_RECEIPTS:
        this.handleMessageGetReceipts(peer)
        break

      case ETH.MESSAGE_CODES.NEW_BLOCK:
        this.handleMessageNewBlock(payload, peer)
        break

      case ETH.MESSAGE_CODES.NEW_BLOCK_HASHES:
        this.handleMessageNewBlockHashes(payload, peer)
        break

      case ETH.MESSAGE_CODES.TX:
        this.handleMessageTx(payload, peer)
        break

      case ETH.MESSAGE_CODES.RECEIPTS:
        break

      case ETH.MESSAGE_CODES.NODE_DATA:
        break
    }
  }

  handleMessageBlockBodies (payload: Object, peer: Object) {
    const peerAddr = getPeerAddr(peer)
    if (DAO_FORK_SUPPORT && !this._forkVerifiedForPeer[peerAddr]) {
      return
    }

    const { inspect } = require('util')
    this._logger.debug(`BLOCK_BODIES_before ${peerAddr} ${inspect(payload[0].length)}`)

    if (payload.length !== 1) {
      this._logger.debug(`${peerAddr} not more than one block body expected (received: ${payload.length})`)
      return
    }

    for (const rawBody of payload) {
      const header = this._peerRequests[peerAddr].headers.shift()
      const block = new EthereumBlock([
        header.raw,
        rawBody[0],
        rawBody[1]
      ])

      this._logger.debug(`BLOCK_BODIES: ${peerAddr} ${inspect(header.hash().toString('hex'))} waiting for: ${inspect(this._peerRequests[peerAddr].headers.map(h => h.hash().toString('hex')))}`)
      isValidBlock(block).then(isValid => {
        const blockNumber = new BN(header.number).toNumber()
        if (isValid) {
          let isBlockFromInitialSync = false
          this._logger.debug(`BLOCK_BODIES_valid: ${peerAddr} ${inspect(header.hash().toString('hex'))}`)
          if (contains(blockNumber, this._requestedBlocks)) {
            this._logger.debug(`Requested block number ${blockNumber} fetched`)
            this._requestedBlocks = without([blockNumber], this._requestedBlocks)
            isBlockFromInitialSync = true
          }
          const msg = (this._requestedBlocks.length < 8) ? inspect(this._requestedBlocks) : `[${this._requestedBlocks[0]} - ${this._requestedBlocks[this._requestedBlocks.length-1]}]`;
          this._logger.debug(`Requested blocks to fetch: ${msg}`) // NOTE: initial sync debug -> info
          this.onNewBlock(block, peer, isBlockFromInitialSync)
        } else {
          this._logger.info(`Disconnecting ${peerAddr} for invalid block body`)
          if (ws) {
            ws.write(peerAddr + '\n')
          }
          peer && peer.disconnect && peer.disconnect(RLPx.DISCONNECT_REASONS.USELESS_PEER)
          if (peerAddr in this._forkVerifiedForPeer) {
            delete this._forkVerifiedForPeer[peerAddr]
          }
        }
      })
    }

    if (isEmpty(this._requestedBlocks) && !isEmpty(this._initialSyncBlocksToFetch)) {
      const batch = head(take(1, this._initialSyncBlocksToFetch))
      this._initialSyncBlocksToFetch = drop(1, this._initialSyncBlocksToFetch)
      if (!batch) {
        this._logger.warn(`Empty intervals to request: ${JSON.stringify(this._initialSyncBlocksToFetch)}`)
        return
      }
      this.requestBlockRange(batch)
    }

    // TODO this should ideally happen just once
    if (isEmpty(this._initialSyncBlocksToFetch)) {
      this.emit('reportSyncStatus', true)
    }
  }

  handleMessageBlockHeaders (payload: Object, peer: Object) {
    const { inspect } = require('util')
    // this._logger.debug(`BLOCK_HEADERS (1), ${getPeerAddr(peer)}, payload: ${inspect(payload)}`)
    const header = new EthereumBlock.Header(payload[0])
    const blockNumber = new BN(header.number).toNumber()
    const peerAddr = getPeerAddr(peer)
    this._logger.debug(`BLOCK_HEADERS, ${peerAddr} hash: ${header.hash().toString('hex')}, number: ${blockNumber}, expected: ${inspect(this._requestedBlocks)}`)

    // this branch handles receive of DAO fork block and thus should check
    // if there is exactly one block in this reply
    if (DAO_FORK_SUPPORT && !this._forkVerifiedForPeer[peerAddr]) {
      if (payload.length !== 1) {
        this._logger.debug(`${peerAddr} expected one header for DAO fork verify (received: ${payload.length})`)
        return
      }

      const expectedHash = DAO_FORK_SUPPORT ? ETH_1920000 : ETC_1920000
      if (header.hash().toString('hex') === expectedHash) {
        this._logger.debug(`${peerAddr} verified to be on the same side of the DAO fork`)
        const timeout = this._forkDrops[peerAddr]
        if (timeout) {
          clearTimeout(timeout)
        }
        this._forkVerifiedForPeer[peerAddr] = peer
        setTimeout(() => {
          const peer = this._forkVerifiedForPeer[peerAddr]
          delete this._forkVerifiedForPeer[peerAddr]
          // disconnect the peer to refresh the connection
          peer && peer.disconnect && peer.disconnect(RLPx.DISCONNECT_REASONS.DISCONNECT_REQUESTED)
        }, 10 * 60 * 1000)
      } else {
        this._logger.debug(`disconnecting non ETH peers: ${peerAddr} `)
        let timeout = this._forkDrops[peerAddr]
        if (timeout) {
          clearTimeout(timeout)
        }
        peer && peer.disconnect && peer.disconnect(RLPx.DISCONNECT_REASONS.USELESS_PEER)
      }
    } else {
      this._logger.debug(`Requesting whole block`)
      // if header which was requested from rover came, request whole block body
      for (const rawHeader of payload) {
        const header = new EthereumBlock.Header(rawHeader)
        const blockNumber = new BN(header.number).toNumber()
        if (this._blocksCache.has(header.hash().toString('hex'))) {
          this._logger.info(`Not requesting whole block ${blockNumber}, we've already seen it`)
          continue
        }
        this._logger.debug(`Requesting whole block number ${blockNumber}`) // NOTE: initial sync debug -> info
        const eth = peer.getProtocols()[0]
        if (contains(blockNumber, this._requestedBlocks)) {
          this._logger.debug(`Sending request for block ${blockNumber}, h: ${header.hash().toString('hex')} to peer ${peerAddr}`) // NOTE: initial sync debug -> info
          setTimeout(() => {
            eth.sendMessage(
              ETH.MESSAGE_CODES.GET_BLOCK_BODIES,
              [header.hash()]
            )
            this._peerRequests[peerAddr].headers.push(header)
          }, 100) // 0.1 sec
        } else {
          this._logger.debug(`Sending normal request with unrequested header`)
          let isValidPayload = false
          while (this._peerRequests[peerAddr].hashes.length > 0) {
            const blockHash = this._peerRequests[peerAddr].hashes.shift()
            if (header.hash().equals(blockHash)) {
              isValidPayload = true
              setTimeout(() => {
                eth.sendMessage(
                  ETH.MESSAGE_CODES.GET_BLOCK_BODIES,
                  [blockHash]
                )
                this._peerRequests[peerAddr].headers.push(header)
              }, 100) // 0.1 sec
              break
            }
          }

          if (this.initialResync) {
            this._logger.info('Requesting initial resync')
            this.scheduleInitialSync(blockNumber)
            this.initialResync = false
          }

          if (!isValidPayload) {
            this._logger.debug(`${peerAddr} received wrong block header ${header.hash().toString('hex')}`)
          }
        }
      }
    }
  }

  handleMessageGetBlockBodies (peer: Object) {
    const eth = peer.getProtocols()[0]
    eth.sendMessage(ETH.MESSAGE_CODES.BLOCK_BODIES, [])
  }

  handleMessageGetBlockHeaders (payload: Object, peer: Object) {
    const eth = peer.getProtocols()[0]
    const headers = []
    // hack
    if (DAO_FORK_SUPPORT && _util.buffer2int(payload[0]) === 1920000) {
      headers.push(ETH_1920000_HEADER)
    }

    eth.sendMessage(ETH.MESSAGE_CODES.BLOCK_HEADERS, headers)
  }

  handleMessageGetNodeData (peer: Object) {
    const eth = peer.getProtocols()[0]
    eth.sendMessage(ETH.MESSAGE_CODES.NODE_DATA, [])
  }

  handleMessageGetReceipts (peer: Object) {
    const eth = peer.getProtocols()[0]
    eth.sendMessage(ETH.MESSAGE_CODES.RECEIPTS, [])
  }

  handleMessageNewBlock (payload: Object, peer: Object) {
    if (DAO_FORK_SUPPORT && !this._forkVerifiedForPeer[getPeerAddr(peer)]) {
      return
    }

    const newBlock = new EthereumBlock(payload[0])

    isValidBlock(newBlock).then(isValid => {
      if (isValid) {
        this.onNewBlock(newBlock, peer, false)
      }
    })
  }

  handleMessageNewBlockHashes (payload: Object, peer: Object) {
    if (DAO_FORK_SUPPORT && !this._forkVerifiedForPeer[getPeerAddr(peer)]) {
      return
    }

    const eth = peer.getProtocols()[0]
    for (let item of payload) {
      const blockHash = item[0]
      if (this._blocksCache.has(blockHash.toString('hex'))) {
        continue
      }

      setTimeout(() => {
        eth.sendMessage(
          ETH.MESSAGE_CODES.GET_BLOCK_HEADERS,
          [blockHash, 1, 0, 0]
        )

        this._peerRequests[getPeerAddr(peer)].hashes.push(blockHash)
      }, 100) // 0.1 sec
    }
  }

  handleMessageTx (payload: Object, peer: Object) {
    if (DAO_FORK_SUPPORT && !this._forkVerifiedForPeer[getPeerAddr(peer)]) {
      return
    }

    for (let item of payload) {
      const tx = new EthereumTx(item)
      if (isValidTx(tx)) {
        this.onNewTx(tx, peer)
      }
    }
  }

  handlePeerAdded (rlpx: RLPx, peer: Object) {
    const peerAddr = getPeerAddr(peer)

    const eth = peer.getProtocols()[0]
    this._peerRequests[peerAddr] = {
      hashes: [],
      headers: []
    }

    const clientId = peer.getHelloMessage().clientId

    this._logger.debug(`Add peer: (${peerAddr}, ${clientId}), eth${eth.getVersion()}, total: ${rlpx.getPeers().length}`)

    // send status, see:
    // https://github.com/ethereum/go-ethereum/blob/master/params/config.go
    // and
    // https://ethereum.stackexchange.com/a/17101
    // for reference
    //
    // main network, eth rover watches metropolis
    if (true || BC_NETWORK === 'main') { // eslint-disable-line
      eth.sendStatus({
        networkId: 1,
        td: _util.int2buffer(17179869184), // total difficulty in genesis block
        bestHash: Buffer.from(
          'd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
          'hex'
        ),
        genesisHash: Buffer.from(
          'd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
          'hex'
        )
      })
    } else { // test network, eth rover watches ropsten
      eth.sendStatus({
        networkId: 3,
        td: _util.int2buffer(1048576), // total difficulty in genesis block
        bestHash: Buffer.from(
          '41941023680923e0fe4d74a34bdac8141f2540e3ae90623718e47d66d1ca4a2d',
          'hex'
        ),
        genesisHash: Buffer.from(
          '41941023680923e0fe4d74a34bdac8141f2540e3ae90623718e47d66d1ca4a2d',
          'hex'
        )
      })
    }

    // check DAO if on mainnet
    eth.once('status', () => {
      if (DAO_FORK_SUPPORT === null) {
        return
      }

      eth.sendMessage(ETH.MESSAGE_CODES.GET_BLOCK_HEADERS, [
        1920000,
        1,
        0,
        0
      ])

      this._forkDrops[peerAddr] = setTimeout(() => {
        peer && peer.disconnect && peer.disconnect(RLPx.DISCONNECT_REASONS.USELESS_PEER)
      }, 15000 /* 15 sec */)

      peer.once('close', () => {
        const timeout = this._forkDrops[peerAddr]
        if (timeout) {
          clearTimeout(timeout)
        }

        if (peerAddr in this._forkVerifiedForPeer) {
          delete this._forkVerifiedForPeer[peerAddr]
        }
      })
    })

    eth.on('message', async (code, payload) => {
      this.handleMessage(rlpx, code, payload, peer)
    })
  }

  handlePeerError (dpt: DPT, peer: Object, err: Error) {
    // $FlowFixMe
    if (err.code === 'ECONNRESET') {
      return
    }

    if (err instanceof assert.AssertionError) {
      const peerId = peer.getId()

      if (peerId !== null) {
        dpt.banPeer(peerId, 300000 /* 5 minutes */)
      }

      this._logger.debug(`Peer error (${getPeerAddr(peer)}): ${err.message}`)
      return
    }

    this._logger.debug(`Peer error (${getPeerAddr(peer)}): ${err.stack || err.toString()}`)
  }

  handlePeerRemoved (rlpx: Object, peer: Object, reason: Object, disconnectWe: boolean) {
    const who = disconnectWe ? 'we disconnect' : 'peer disconnect'
    const total = rlpx.getPeers().length
    const reasonCode = DISCONNECT_REASONS[parseInt(String(reason), 10)]
    this._logger.debug(`Remove peer (${getPeerAddr(peer)}): ${who}, reason code: ${reasonCode}, total: ${total}`)
    delete this._peerRequests[getPeerAddr(peer)]
  }

  onError (msg: string, err: Error) {
    this._logger.debug(`Error: ${msg} ${err.toString()}`)
  }

  // TODO port is never used
  run (port: number) {
    // DPT
    this._dpt = new DPT(this._key, {
      refreshInterval: 30000,
      timeout: 25000,
      endpoint: {
        address: '0.0.0.0',
        udpPort: null,
        tcpPort: null
      }
    })

    this._dpt.on('error', (err) => this.onError('DPT Error', err))

    const rlpx = this._rlpx = new RLPx(this._key, {
      dpt: this._dpt,
      maxPeers: this._maximumPeers,
      capabilities: [ETH.eth63, ETH.eth62],
      listenPort: null
    })

    rlpx.on('error', (err) => this.onError('RLPX Error', err))

    rlpx.on('peer:added', (peer) => this.handlePeerAdded(rlpx, peer))

    rlpx.on('peer:removed', (peer, reason, disconnectWe) => this.handlePeerRemoved(rlpx, peer, reason, disconnectWe))

    rlpx.on('peer:error', (peer, err) => this.handlePeerError(this._dpt, peer, err))

    BOOTNODES.forEach((node) => {
      // $FlowFixMe
      this._dpt.bootstrap(node).catch(err => {
        this._logger.debug(`DPT bootstrap error: ${err.stack || err.toString()}`)
      })
    })

    setInterval(() => {
      // $FlowFixMe
      const peersCount = this._dpt.getPeers().length
      const openSlots = this.rlpx._getOpenSlots()
      const queueLength = this.rlpx._peersQueue.length
      const queueLength2 = this.rlpx._peersQueue.filter(o => o.ts <= Date.now()).length
      this._logger.debug(`Rover peers ${peersCount}, open slots: ${openSlots}, queue: ${queueLength} / ${queueLength2}`)
    }, 30000 /* 30 sec */)
  }

  close () {
    // TODO implement disconnect
    this._syncCheckTimeout && clearInterval(this._syncCheckTimeout)
  }
}
