const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')
const uuidv4 = require('uuid/v4')
const wrtc = require('wrtc')
const pump = require('pump')
const EventEmitter = require('events')

const HUB_URL = 'localhost:8080'
const DEBUG = false
const debug = (str) => {
  if (DEBUG) console.log(str)
}

/**
 * Return when hyperDb instance is ready
 * @param {Object} db - The hyperDb instance
 */
const dbReady = (db) => {
  return new Promise((resolve, reject) => {
    db.on('ready', () => {
      resolve()
    })
  })
}

class Masq extends EventEmitter {
  /**
   * constructor
   * @param {string} app - The application name
   */
  constructor (app) {
    super()
    this.profile = null
    this.sws = {}
    this.swProfilesReplication = null
    this.hubs = {}
    this.hubProfilesReplication = null
    this.app = app
    this.channel = null
    this.challenge = null
    this.dbs = {
      profiles: null // masq public profiles
    }
    this._generateLinkParameters()
  }

  async init () {
    await this._openAndSyncDatabases()
  }

  /**
   * Get all profiles registered in masq
   */
  getProfiles () {
    return new Promise((resolve, reject) => {
      const db = this.dbs.profiles
      db.get('/users', (err, nodes) => {
        if (err) return reject(err)
        if (!nodes.length) return resolve([])
        resolve(nodes[0].value)
      })
    })
  }

  /**
   * Set the current profile
   * @param {string} id - The profile id
   */
  setProfile (id) {
    // check id
    this.profile = id
  }

  /**
 * Return the value of a given key
 * @param {Object} db - The hyperdb instance
 * @param {string} key - The key
 * @returns {string|Object} - The value
 */
  get (db, key) {
    return new Promise((resolve, reject) => {
      db.get(key, function (err, data) {
        if (err) reject(err)
        if (!data[0]) {
          resolve(null)
        } else {
          resolve(data[0].value)
        }
      })
    })
  }

  /**
 * Return the value of a given key in data db
 * @param {string} key - The key
 * @returns {string|Object} - The value
 */
  getItem (key) {
    const db = this.dbs.data
    return new Promise((resolve, reject) => {
      db.get(key, function (err, data) {
        if (err) reject(err)
        if (!data[0]) {
          resolve(null)
        } else {
          resolve(data[0].value)
        }
      })
    })
  }

  /**
 * Set a key to the hyperdb
 * @param {Object} db - The hyperdb instance
 * @param {string} key - The key
 * @param {Object|string} value - The content
 * @returns {int} -The sequence number
 */
  set (db, key, value) {
    return new Promise((resolve, reject) => {
      db.put(key, value, err => {
        if (err) reject(err)
        resolve(value)
      })
    })
  }

  /**
 * Set a key to the data hyperdb
 * @param {string} key - The key
 * @param {Object|string} value - The content
 * @returns {int} -The sequence number
 */
  setItem (key, value) {
    const db = this.dbs.data
    return new Promise((resolve, reject) => {
      db.put(key, value, err => {
        if (err) reject(err)
        resolve(value)
      })
    })
  }

  /**
   * Delete a key
   * @param {string} key - Key
   */
  del (key) {
    return new Promise((resolve, reject) => {
      if (!this.profile) return reject(Error('No profile selected'))
      const db = this.dbs[this.profile]
      db.del(key, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  requestMasqAccess () {
    // Subscribe to channel for a limited time to sync with masq
    const hub = signalhub(this.channel, [HUB_URL])
    let sw = null

    if (swarm.WEBRTC_SUPPORT) {
      sw = swarm(hub)
    } else {
      sw = swarm(hub, { wrtc: require('wrtc') })
    }

    sw.on('peer', (peer, id) => {
      // check challenges
      peer.on('data', data => _handleData(data, peer))
    })

    sw.on('close', () => {
      debug(' requestMasqAccess : close on masq-lib')
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      debug(' requestMasqAccess : disconnect on masq-lib')
      sw.close()
      hub.close()
    })

    const _handleData = async (data, peer) => {
      const json = JSON.parse(data)

      switch (json.msg) {
        case 'sendProfilesKey':
          if (json.challenge !== this.challenge) {
            // This peer may be malicious, close the connection
            sw.close()
            hub.close()
          } else {
            // db creation and replication
            const db = hyperdb(rai('masq-profiles'), Buffer.from(json.key, 'hex'), { valueEncoding: 'json' })
            await dbReady(db)

            // Store
            this.dbs.profiles = db

            this._startReplication(db)

            peer.send(JSON.stringify({
              msg: 'replicationProfilesStarted'
            }))
          }
          break
        default:
          console.log('The message type is false.')
          break
      }
    }
  }

  exchangeDataHyperdbKeys (appName) {
    // Subscribe to channel for a limited time to sync with masq
    const hub = signalhub(this.channel, [HUB_URL])
    let sw = null

    if (swarm.WEBRTC_SUPPORT) {
      sw = swarm(hub)
    } else {
      sw = swarm(hub, { wrtc: require('wrtc') })
    }

    sw.on('peer', (peer, id) => {
      // check challenges
      peer.on('data', data => _handleData(data, peer, appName, sw))
    })

    sw.on('close', () => {
      debug(' exchangeDataHyperdbKeys : close on masq-lib')
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      debug(' exchangeDataHyperdbKeys : disconnect on masq-lib')
      sw.close()
      hub.close()
    })

    const _handleData = async (data, peer) => {
      const json = JSON.parse(data)

      switch (json.msg) {
        case 'sendDataKey':
          if (json.challenge !== this.challenge) {
            // This peer may be malicious, close the connection
            sw.close()
            hub.close()
          } else {
            // db creation and replication
            const db = hyperdb(rai(appName), Buffer.from(json.key, 'hex'), { valueEncoding: 'json' })
            await dbReady(db)
            // Store
            this.dbs.data = db

            peer.send(JSON.stringify({
              msg: 'requestWriteAccess',
              key: db.local.key.toString('hex')
            }))
          }
          break
        case 'ready':
          this._startDataReplication(this.dbs.data, appName)
          sw.close()
          break
        default:
          console.log('The message type is false.')
          break
      }
    }
  }

  async _startReplication (db) {
    const discoveryKey = db.discoveryKey.toString('hex')
    this.hubs['syncProfiles'] = signalhub(discoveryKey, [HUB_URL])
    const hub = this.hubs['syncProfiles']
    this.sws['syncProfiles'] = swarm(hub, { wrtc })
    const sw = this.sws['syncProfiles']

    sw.on('peer', async (peer, id) => {
      const stream = db.replicate({ live: true })
      pump(peer, stream, peer)

      this.peerProfilesReplication = peer
      peer.on('data', data => {
        // do something
      })
    })

    db.watch('/users', async () => {
      this.emit('change', { db: 'masq-profiles', key: '/users' })
    })

    sw.on('close', () => {
      debug(' _startReplication : close on masq-lib')
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      debug(' _startReplication : disconnect on masq-lib')
      sw.close()
      hub.close()
    })
  }

  async _startDataReplication (db, name) {
    const discoveryKey = db.discoveryKey.toString('hex')
    this.hubs[name] = signalhub(discoveryKey, [HUB_URL])
    const hub = this.hubs[name]
    this.sws[name] = swarm(hub, { wrtc })
    const sw = this.sws[name]

    sw.on('peer', async (peer, id) => {
      const stream = db.replicate({ live: true })
      pump(peer, stream, peer)

      this.peer = peer
      peer.on('data', data => {
        // do something
      })
    })

    sw.on('close', () => {
      debug(' _startDataReplication : close on masq-lib')
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      debug(' _startDataReplication : disconnect on masq-lib')
      sw.close()
      hub.close()
    })
  }

  /** open and sync existing databases */
  _openAndSyncDatabase () {
  }

  /** open and sync existing databases */
  _openAndSyncDatabases () {
    // const db = hyperdb(rai('masq-profiles'), { valueEncoding: 'json' })
    // this.dbs.profiles = db
  }

  _generateLinkParameters () {
    this.channel = uuidv4()
    this.challenge = uuidv4()
  }

  _getLink () {
    return `?channel=${this.channel}&challenge=${this.challenge}`
  }
}

module.exports = Masq
