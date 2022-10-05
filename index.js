import HyperSwarm from 'hyperswarm'
import CoreStore from 'corestore'
import Hypercore from 'hypercore'
import crypto from 'hypercore-crypto'
import z32 from 'z32'
import b4a from 'b4a'
import RAA from 'random-access-application'
import RAM from 'random-access-memory'
import { query, wellknown } from 'dns-query'
import { EventEmitter } from 'events'

// TODO: Base36 encoding/decoding for URLs instead of hex

export const HYPER_PROTOCOL_SCHEME = 'hyper://'
export const DNSLINK_TXT_PREFIX = 'dnslink=/hyper/'
export const DEFAULT_CORE_OPTS = {
  sparse: true
}
export const DEFAULT_JOIN_OPTS = {
  server: true,
  client: true
}
export const DEFAULT_CORESTORE_OPTS = {
}
export const DEFAULT_SWARM_OPTS = {
}
export const DEFAULT_DNS_QUERY_OPTS = {
  endpoints: await wellknown.endpoints('doh')
}

// Monkey-patching Hypercore with first class URL support
Object.defineProperty(Hypercore.prototype, 'url', {
  get: function () {
    return `${HYPER_PROTOCOL_SCHEME}${this.id}/`
  }
})

export class SDK extends EventEmitter {
  constructor ({
    swarm = throwMissing('swarm'),
    corestore = throwMissing('corestore'),
    dnsLinkPrefix = DNSLINK_TXT_PREFIX,
    defaultCoreOpts = DEFAULT_CORE_OPTS,
    defaultJoinOpts = DEFAULT_JOIN_OPTS,
    defaultDNSOpts = DEFAULT_DNS_QUERY_OPTS,
    autoJoin = true,
    doReplicate = true
  }) {
    super()
    this.swarm = swarm
    this.corestore = corestore

    this.dnsLinkPrefix = dnsLinkPrefix
    this.defaultCoreOpts = defaultCoreOpts
    this.defaultJoinOpts = defaultJoinOpts
    this.defaultDNSOpts = defaultDNSOpts

    this.autoJoin = autoJoin

    if (doReplicate) {
      swarm.on('connection', (connection, peerInfo) => {
        this.emit('peer-add', peerInfo)
        connection.once('close', () => this.emit('peer-remove', peerInfo))
        this.replicate(connection)
      })
    }
  }

  get id () {
    return this.swarm.keyPair.publicKey
  }

  get connections () {
    return this.swarm.connections
  }

  get peers () {
    return this.swarm.peers
  }

  get cores () {
    return this.corestore.cores
  }

  async resolveDNSToKey (domain, opts = {}) {
    const finalOpts = { ...this.defaultDNSOpts, ...opts }
    const name = `_dnslink.${domain}`

    const { answers } = await query({
      question: { type: 'txt', name }
    }, finalOpts)

    for (const { data } of answers) {
      if (!data || !data.length) continue
      const [raw] = data
      if (!raw) return
      const asString = raw.toString('utf8')
      if (asString.startsWith(this.dnsLinkPrefix)) return asString.slice(this.dnsLinkPrefix.length)
    }
    throw new Error(`Unable to resolve DNSLink domain for ${domain}. If you are the site operator, please add a TXT record pointing at _dnslink.${domain} with the value dnslink=/hyper/YOUR_KEY_IN_Z32_HERE`)
  }

  async get (nameOrKeyOrURL, opts = {}) {
    const coreOpts = {
      ...this.defaultCoreOpts,
      autoJoin: this.autoJoin,
      ...opts
    }

    const isKeyString = (typeof nameOrKeyOrURL === 'string')

    // If a URL, use the hostname as either a key or a DNS to resolve
    // If not a URL, try to decode to a key
    // if not a key, use as name to generate a hypercore

    // If a 32 byte buffer, use it as the key
    if (nameOrKeyOrURL && !isKeyString && nameOrKeyOrURL.length === 32) {
      coreOpts.key = nameOrKeyOrURL
    } else if (isKeyString) {
      if (nameOrKeyOrURL.startsWith(HYPER_PROTOCOL_SCHEME)) {
        const url = new URL(nameOrKeyOrURL)
        // probably a domain
        if (url.hostname.includes('.')) {
          const resolved = await this.resolveDNSToKey(url.hostname)
          coreOpts.key = stringToKey(resolved)
        } else {
          // Try to parse the hostname to a key
          coreOpts.key = stringToKey(url.hostname)
          if (!coreOpts.key) {
            // If not a key or a domain, throw an error
            throw new Error('URLs must have either an encoded key or a valid DNSlink domain')
          }
        }
      } else {
        const parsed = stringToKey(nameOrKeyOrURL)
        if (parsed) {
          coreOpts.key = parsed
        } else {
          coreOpts.name = nameOrKeyOrURL
        }
      }
    }

    // There shouldn't be a way to pass null for the key
    const core = this.corestore.get(coreOpts)

    // Await for core to be ready
    await core.ready()

    if (coreOpts.autoJoin && !core.discovery) {
      console.log('Auto joining')
      const discovery = this.join(core.discoveryKey, opts)
      core.discovery = discovery

      // Await for initial peer if not writable
      if (!core.writable && !core.length) {
        await discovery.flushed()
      }

      core.once('close', () => {
        discovery.destroy()
      })
    }

    return core
  }

  // Returns a corestore for a namespace
  namespace (namespace) {
    return this.corestore.namespace(namespace)
  }

  makeTopicKey (name) {
    const [key] = crypto.namespace(name, 1)
    return key
  }

  join (topic, opts = {}) {
    if (typeof topic === 'string') {
      return this.join(this.makeTopicKey(topic), opts)
    }
    const joinOpts = { ...this.defaultJoinOpts, ...opts }
    return this.swarm.join(topic, joinOpts)
  }

  leave (topic) {
    if (typeof topic === 'string') {
      return this.leave(this.makeTopicKey(topic))
    }
    return this.swarm.leave(topic)
  }

  joinPeer (id) {
    return this.swarm.joinPeer(id)
  }

  leavePeer (id) {
    return this.swarm.leavePeer(id)
  }

  async ready () {
    // Wait for the network to be configured?
    await this.corestore.ready()
    await this.swarm.listen()
  }

  async close () {
    // Close corestore, close hyperswarm
    await Promise.all([
      this.corestore.close(),
      this.swarm.destroy()
    ])
  }

  replicate (connection) {
    this.corestore.replicate(connection)
  }
}

export async function create ({
  storage = 'hyper-sdk',
  corestoreOpts = DEFAULT_CORESTORE_OPTS,
  swarmOpts = DEFAULT_SWARM_OPTS,
  ...opts
} = {}) {
  const isStringStorage = typeof storage === 'string'
  const isPathStorage = isStringStorage && (
    storage.startsWith('.') ||
     storage.startsWith('/') ||
     storage.startsWith('\\')
  )

  let storageBackend = storage
  if (isStringStorage && !isPathStorage) {
    storageBackend = RAA(storage)
  } else if (storage === false) {
    storageBackend = RAM
  }

  const corestore = opts.corestore || new CoreStore(storageBackend, { ...corestoreOpts })

  const networkKeypair = await corestore.createKeyPair('noise')

  const swarm = opts.swarm || new HyperSwarm({
    keyPair: networkKeypair,
    ...swarmOpts
  })

  const sdk = new SDK({
    swarm,
    corestore,
    ...opts
  })

  await sdk.ready()

  return sdk
}

function stringToKey (string) {
  if (string.length === 52) {
    try {
      return z32.decode(string)
    } catch {
      // Not formatted properly, probs a name?
    }
  } else if (string.length === 64) {
    // Parse as hex key
    try {
      return b4a.from(string, 'hex')
    } catch {
      // Not formatted properly, probs a name?
    }
  }
  return null
}

function throwMissing (name) {
  throw new TypeError(`Missing parameter ${name}`)
}
