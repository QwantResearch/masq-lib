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

class MasqCore extends EventEmitter {
  /**
   * constructor
   */
  constructor () {
    super()
    this.currentProfile = null
    this.currentId = null
    this.sws = {}
    this.hubs = {}
    this.channels = null
    this.challenge = null
    this.peer = null
    this.peers = {}
    this.masqProfiles = null
    this.dbs = {
      masqProfiles: null // masq public profiles
    }
  }

  async init () {
    await this.initProfiles()
  }

  async initProfiles () {
    return new Promise((resolve, reject) => {
      this.masqProfiles = hyperdb(rai('masq-profiles'), { valueEncoding: 'json' })
      this.masqProfiles.on('ready', async () => {
        const profiles = await this.get(this.masqProfiles, '/users')
        if (!profiles) {
          try {
            await this.set(this.masqProfiles, '/users', [])
          } catch (error) {
            console.log(error)
          }
        }
        resolve()
      })
    })
  }

  async createAppDb (name) {
    return new Promise((resolve, reject) => {
      this.dbs[name] = hyperdb(rai('name'), { valueEncoding: 'json' })
      this.dbs[name].on('ready', async () => {
        resolve(this.dbs[name].key)
      })
    })
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
 * Return the value of a given key for a specific db
 * @param {string} dbName - The hyperdb instance name
 * @param {string} key - The key
 * @returns {string|Object} - The value
 */
  getItem (dbName, key) {
    const db = this.dbs[dbName]
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
 * Add a write permission to the db
 * @param {Object} db - The hyperdb instance
 * @param {Buffer} key - The key we will give the write permission
 */
  authorize (db, key) {
    return new Promise((resolve, reject) => {
      db.authorize(key, err => {
        if (err) reject(err)
        resolve()
      })
    })
  }

  async getProfiles () {
    return this.get(this.masqProfiles, '/users')
  }

  async setProfiles (profiles) {
    await this.set(this.masqProfiles, '/users', profiles)
  }

  async setProfile (username, profile) {
    const id = uuidv4()
    const listProfiles = await this.getProfiles()

    const newProfiles = [...listProfiles, { username: username, id: id }]
    await this.setProfiles(newProfiles)
    await this.set(this.masqProfiles, `/users/${id}/profile`, profile)
  }

  async getProfile (username) {
    const id = await this.getId(username)
    const profile = id ? await this.get(this.masqProfiles, `/users/${id}/profile`) : null
    return profile
  }

  async getId (username) {
    const listProfiles = await this.getProfiles()
    const profile = listProfiles.filter(p => p.username === username)
    return profile[0].id
  }

  getSyncProfilesHub () {
    return this.hubs.syncProfiles
  }

  getSyncProfilesSw () {
    return this.sws.syncProfiles
  }

  getDataHub (appName) {
    return this.hubs[appName]
  }

  getDataSw (appName) {
    return this.sws[appName]
  }

  receiveLink (info) {
    switch (info.type) {
      case 'syncProfiles':
        this.exchangeProfilesKey(info.channel, info.challenge)

        break
      case 'syncData':
        this.exchangeDataHyperdbKeys(info.channel, info.challenge, info.appName)

        break

      default:
        break
    }
  }

  async exchangeProfilesKey (channel, challenge) {
    const hub = signalhub(channel, [HUB_URL])
    const sw = swarm(hub, { wrtc })

    sw.on('peer', (peer, id) => {
      peer.on('data', data => {
        const json = JSON.parse(data)
        if (json.msg === 'replicationProfilesStarted') {
          this.startReplication(this.masqProfiles)
        }
        sw.close()
        hub.close()
      })

      peer.send(JSON.stringify({
        msg: 'sendProfilesKey',
        challenge: challenge,
        key: this.masqProfiles.key.toString('hex')
      }))
    })

    sw.on('close', () => {
      debug('exchangeProfilesKey : close hub on masqCore')
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      debug('exchangeProfilesKey : disconnect hub on masqCore')
      sw.close()
      hub.close()
    })
  }

  async exchangeDataHyperdbKeys (channel, challenge, name) {
    const hub = signalhub(channel, [HUB_URL])
    const sw = swarm(hub, { wrtc })
    const key = await this.createAppDb(name)

    // replicationProfilesStarted
    sw.on('peer', (peer, id) => {
      // this.startDataReplication(this.masqProfiles)

      peer.on('data', data => _handleData(data, peer, name))

      peer.send(JSON.stringify({
        msg: 'sendDataKey',
        challenge: challenge,
        key: key.toString('hex')
      }))
    })

    sw.on('close', () => {
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      sw.close()
      hub.close()
    })

    const _handleData = async (data, peer) => {
      const json = JSON.parse(data)
      switch (json.msg) {
        case 'requestWriteAccess':
          await this.authorize(this.dbs[name], Buffer.from(json.key, 'hex'))
          this.startDataReplication(this.dbs[name], name)
          peer.send(JSON.stringify({
            msg: 'ready'
          }))
          break
        default:
          console.log('The message type is false.')
          break
      }
    }
  }

  startReplication (db) {
    const discoveryKey = db.discoveryKey.toString('hex')
    this.hubs['syncProfiles'] = signalhub(discoveryKey, [HUB_URL])
    const hub = this.hubs['syncProfiles']
    this.sws['syncProfiles'] = swarm(hub, { wrtc })
    const sw = this.sws['syncProfiles']

    sw.on('peer', (peer, id) => {
      // start replication
      const stream = db.replicate({ live: true })
      pump(peer, stream, peer)
      this.peerProfilesReplication = peer
      peer.on('data', data => {
      })
    })

    db.watch('/users', function () {
    })

    sw.on('close', () => {
      debug('startReplication : close hub on masqCore')
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      debug('startReplication : disconnect sw on masqCore')
      sw.close()
      hub.close()
    })
  }

  startDataReplication (db, name) {
    const discoveryKey = db.discoveryKey.toString('hex')
    this.hubs[name] = signalhub(discoveryKey, [HUB_URL])
    const hub = this.hubs[name]
    this.sws[name] = swarm(hub, { wrtc })
    const sw = this.sws[name]

    sw.on('peer', (peer, id) => {
      // start replication
      const stream = db.replicate({ live: true })
      pump(peer, stream, peer)
      this.peers[name] = peer
      peer.on('data', data => {
      })
    })

    db.watch('/hello', async () => {
      this.emit('changeDataHello', { db: name, key: '/hello' })
    })

    sw.on('close', () => {
      debug(' startDataReplication : close on masqCore')
      hub.close()
    })

    sw.on('disconnect', (peer, id) => {
      debug(' startDataReplication : disconnect on masqCore')
      sw.close()
      hub.close()
    })
  }
}

module.exports = MasqCore
