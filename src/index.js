// const swarm = require('webrtc-swarm')
// const signalhub = require('signalhubws')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')

// const hub = signalhub('swarm-example', ['localhost:8080'])

class Masq {
  /**
   * constructor
   * @param {string} app - The application name
   */
  constructor (app) {
    this.profile = null
    this.sw = null
    this.app = app
    this.dbs = {
      profiles: null // masq public profiles
    }
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
      console.log('getProfiles')
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
   * Put a new value in the current profile database
   * @param {string} key - Key
   * @param {string} value - The value to insert
   */
  put (key, value) {
    return new Promise((resolve, reject) => {
      if (!this.profile) return reject(Error('No profile selected'))
      const db = this.dbs[this.profile]
      db.put(key, value, err => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  /**
   * Get a value
   * @param {string} key - Key
   */
  get (key) {
    return new Promise((resolve, reject) => {
      if (!this.profile) return reject(Error('No profile selected'))
      const db = this.dbs[this.profile]
      db.get(key, (err, nodes) => {
        if (err) return reject(err)
        resolve(nodes)
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

  /** open and sync existing databases */
  _openAndSyncDatabases () {
    const db = hyperdb(rai('masq-profiles'), { valueEncoding: 'json' })
    this.dbs.profiles = db
  }
}

module.exports = Masq
