const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const uuidv4 = require('uuid/v4')
const pump = require('pump')

const common = require('masq-common')
const ERRORS = common.errors.ERRORS
const MasqError = common.errors.MasqError

const config = require('../config/config')

const debug = (function () {
  switch (process.env.NODE_ENV) {
    case ('development'):
      return console.log
    default:
      return () => {}
  }
})()

const createSwarm = (hub) => {
  return swarm(hub, {
    wrtc: !swarm.WEBRTC_SUPPORT ? require('wrtc') : null,
    config: config.SWARM_CONFIG
  })
}

class Masq {
  /**
   * constructor
   * @param {string} appName - The application name
   */
  constructor (appName, appDescription, appImageURL) {
    this._reset()

    this.appName = appName
    this.appDescription = appDescription
    this.appImageURL = appImageURL

    this.userId = null
    this.dataEncryptionKey = null
    this.userAppDb = null

    this._loadSessionInfo()

    // login state data
    this.loginChannel = null
    this.loginKey = null
    this.loginUrl = null
  }

  _reset () {
    this.userAppRepSW = null
    this.userAppRepHub = null

    this._logIntoMasqErr = null
    this._logIntoMasqDone = false
  }

  isLoggedIn () {
    // is logged in if the userAppDbId is known
    // (either after register or after construction and load session info)
    return !!this.userId
  }

  isConnected () {
    // is connected if the userAppDb has been created and initialized
    return !!this.userAppDb
  }

  async connectToMasq () {
    if (!this.isLoggedIn()) {
      await this._disconnect()
      throw new MasqError(ERRORS.NOT_LOGGED_IN)
    }

    const db = common.utils.createPromisifiedHyperDB(this.userId)
    this.userAppDb = db
    await common.utils.dbReady(db)
    this._startReplication()
  }

  // function useful to simulate the shutdown of a User-app
  async _disconnect () {
    await new Promise((resolve) => {
      this.userAppDb = null
      if (!this.userAppRepSW) {
        this._reset()
        resolve()
        return
      }
      this.userAppRepSW.close(() => {
        this._reset()
        resolve()
      })
    })

    await this._deleteSessionInfo(false)
  }

  async signout () {
    this.userId = null
    this.userAppDb = null

    await this._disconnect()
    this._deleteSessionInfo(true)
  }

  _deleteSessionInfo (deleteLocal) {
    if (deleteLocal) {
      window.localStorage.removeItem('userId')
    }
    window.sessionStorage.removeItem('userId')
    window.localStorage.removeItem('dataEncryptionKey')
    window.sessionStorage.removeItem('dataEncryptionKey')
  }

  _storeSessionInfo (stayConnected, userId, dataEncryptionKey) {
    if (stayConnected) {
      window.localStorage.setItem('userId', userId)
      window.localStorage.setItem('dataEncryptionKey', dataEncryptionKey)
    }
    window.sessionStorage.setItem('userId', userId)
    window.sessionStorage.setItem('dataEncryptionKey', dataEncryptionKey)
  }

  async _loadSessionInfo () {
    // If userId is in sesssion storage, use it and do not touch localStorage
    const sessionUserId = window.sessionStorage.getItem('userId')
    const sessionDataEncryptionKey = window.sessionStorage.getItem('dataEncryptionKey')
    if (sessionUserId && sessionDataEncryptionKey) {
      this.userId = sessionUserId
      this.dataEncryptionKey = await common.crypto.importKey(Buffer.from(sessionDataEncryptionKey, 'hex'))
      return
    }

    // if userId is is not in session storage, look for it in local storage
    // and save in session storage
    const localStorageUserId = window.localStorage.getItem('userId')
    if (localStorageUserId) {
      this.userId = localStorageUserId
      window.sessionStorage.setItem('userId', this.userId)
    }
    const localStorageDataEncryptionKey = window.localStorage.getItem('dataEncryptionKey')
    if (localStorageDataEncryptionKey) {
      this.dataEncryptionKey = await common.crypto.importKey(Buffer.from(localStorageDataEncryptionKey, 'hex'))
      window.sessionStorage.setItem('dataEncryptionKey', localStorageDataEncryptionKey)
    }
  }

  async _initSwarmWithDataHandler (channel, dataHandler) {
    return new Promise((resolve, reject) => {
      // Subscribe to channel for a limited time to sync with masq
      debug(`Creation of a hub with ${channel} channel name`)
      const hub = signalhub(channel, config.HUB_URLS)
      const sw = createSwarm(hub)

      sw.on('peer', (peer, id) => {
        debug(`The peer ${id} join us...`)
        peer.on('data', (data) => { dataHandler(sw, peer, data) })
      })

      sw.on('disconnect', (peer, id) => {
        sw.close()
      })

      sw.on('close', () => {
        resolve()
      })
    })
  }

  _startReplication () {
    const discoveryKey = this.userAppDb.discoveryKey.toString('hex')
    this.userAppRepHub = signalhub(discoveryKey, config.HUB_URLS)
    this.userAppRepSW = createSwarm(this.userAppRepHub)

    this.userAppRepSW.on('peer', async (peer, id) => {
      const stream = this.userAppDb.replicate({ live: true })
      pump(peer, stream, peer)
    })
  }

  async _isRegistered (userId) {
    // is registered if there is a db for this userId
    return common.utils.dbExists(userId)
  }

  async _requestUserAppRegister (key, peer) {
    const msg = {
      msg: 'registerUserApp',
      name: this.appName,
      description: this.appDescription,
      imageURL: this.appImageURL
    }
    let encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
    peer.send(JSON.stringify(encryptedMsg))
  }

  async _requestWriteAccess (encryptionKey, peer, localDbKey) {
    const msg = {
      msg: 'requestWriteAccess',
      key: localDbKey.toString('hex')
    }
    const encryptedMsg = await common.crypto.encrypt(encryptionKey, msg, 'base64')
    peer.send(JSON.stringify(encryptedMsg))
  }

  async _sendConnectionEstablished (key, peer) {
    const msg = {
      msg: 'connectionEstablished'
    }
    const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')

    peer.send(JSON.stringify(encryptedMsg))
  }

  // All error handling for received messages
  _checkMessage (json, registering, waitingForWriteAccess) {
    switch (json.msg) {
      case 'authorized':
        if (!json.userAppDbId) {
          throw new MasqError(ERRORS.WRONG_MESSAGE, 'User Id not found in \'authorized\' message')
        }
        if (!json.userAppDEK) {
          handleError('User app dataEncryptionKey (userAppDEK) not found in \'authorized\' message')
        }
        break

      case 'notAuthorized':
        break

      case 'masqAccessGranted':
        if (!registering) {
          throw new MasqError(ERRORS.WRONG_MESSAGE, 'Unexpectedly received "masqAccessGranted" message while not registering')
        }

        if (!json.key) {
          throw new MasqError(ERRORS.WRONG_MESSAGE, 'Database key not found in "masqAccessGranted" message')
        }

        if (!json.userAppDbId) {
          throw new MasqError(ERRORS.WRONG_MESSAGE, 'User Id not found in "masqAccessGranted" message')
        }
        if (!json.userAppDEK) {
          handleError('User app dataEncryptionKey (userAppDEK) not found in "masqAccessGranted" message')
        }
        break

      case 'masqAccessRefused':
        if (!registering) {
          throw new MasqError(ERRORS.WRONG_MESSAGE, 'Unexpectedly received "masqAccessRefused" while not registering')
        }
        break

      case 'writeAccessGranted':
        if (!waitingForWriteAccess) {
          throw new MasqError(ERRORS.WRONG_MESSAGE, 'Unexpectedly received "writeAccessGranted" while not waiting for write access')
        }
        break

      default:
        throw new MasqError(ERRORS.WRONG_MESSAGE, `Unexpectedly received message with type ${json.msg}`)
    }
  }

  async getLoginLink () {
    this.loginChannel = uuidv4()
    this.loginKey = await common.crypto.genAESKey(true, 'AES-GCM', 128)
    const extractedKey = await common.crypto.exportKey(this.loginKey)
    const keyBase64 = Buffer.from(extractedKey).toString('base64')
    this.loginUrl = new URL(config.MASQ_APP_BASE_URL)
    const requestType = 'login'
    const hashParams = JSON.stringify([this.appName, requestType, this.loginChannel, keyBase64])
    this.loginUrl.hash = '/' + Buffer.from(hashParams).toString('base64')

    return this.loginUrl.href
  }

  /**
   * If this is the first time, this.dbs.profiles is empty.
   * We need to get masq-profiles hyperdb key of masq.
   * @returns {string, string, string}
   *  link - the link to open the masq app with the right
   */
  async logIntoMasq (stayConnected) {
    // logout if loggedin when called
    if (this.userId) {
      this.signout()
    }

    // make stayConnected a boolean
    stayConnected = !!stayConnected

    // get login channel and key created at login link generation
    const channel = this.loginChannel
    const key = this.loginKey

    let registering = false
    let waitingForWriteAccess = false

    let userId
    let db
    let dataEncryptionKey

    const handleData = async (sw, peer, data) => {
      const handleError = (err) => {
        this._logIntoMasqErr = err
        sw.close()
      }

      // decrypt the received message and check if the right key has been used
      let json
      try {
        json = await common.crypto.decrypt(key, JSON.parse(data), 'base64')
        this._checkMessage(json, registering, waitingForWriteAccess)
      } catch (err) {
        handleError(err)
        return
      }

      switch (json.msg) {
        case 'authorized':
          userId = json.userAppDbId
          dataEncryptionKey = json.userAppDEK

          // Check if the User-app is already registered
          if (await this._isRegistered(userId)) {
            this.userId = userId
            // store the dataEncryptionKey as a CryptoKey
            this.dataEncryptionKey = await common.crypto.importKey(Buffer.from(dataEncryptionKey, 'hex'))
            // Store the session info
            this._storeSessionInfo(stayConnected, userId, dataEncryptionKey)

            await this.connectToMasq()
            // logged into Masq
            await this._sendConnectionEstablished(key, peer)
            sw.close()
            return
          }
          // if this UserApp instance is not registered
          registering = true
          this._requestUserAppRegister(key, peer)
          break

        case 'notAuthorized':
          // if this User-app is not registered
          registering = true
          this._requestUserAppRegister(key, peer)
          break

        case 'masqAccessGranted':
          registering = false

          const buffKey = Buffer.from(json.key, 'hex')
          db = common.utils.createPromisifiedHyperDB(userId, buffKey)
          await common.utils.dbReady(db)

          waitingForWriteAccess = true
          this._requestWriteAccess(key, peer, db.local.key)
          break

        case 'masqAccessRefused':
          registering = false
          handleError(new MasqError(ERRORS.MASQ_ACCESS_REFUSED_BY_USER))
          return

        case 'writeAccessGranted':
          waitingForWriteAccess = false

          // Store the session info
          this._storeSessionInfo(stayConnected, userId, dataEncryptionKey)
          this.userId = userId
          this.dataEncryptionKey = await common.crypto.importKey(Buffer.from(dataEncryptionKey, 'hex'))
          this.userAppDb = db
          this._startReplication()

          sw.close()
          break
      }
    }

    this._initSwarmWithDataHandler(channel, handleData).then(
      () => {
        this._logIntoMasqDone = true
        if (this._onLogIntoMasqDone) this._onLogIntoMasqDone()
      }
    )

    return new Promise((resolve, reject) => {
      if (this._logIntoMasqDone) {
        this._logIntoMasqDone = false
        if (this._logIntoMasqErr) {
          return reject(this._logIntoMasqErr)
        } else {
          return resolve()
        }
      }
      this._onLogIntoMasqDone = () => {
        this._onLogIntoMasqDone = undefined
        this._logIntoMasqDone = false
        if (this._logIntoMasqErr) {
          return reject(this._logIntoMasqErr)
        } else {
          return resolve()
        }
      }
    })
  }

  //
  // Database Access Functions
  //

  _getDB () {
    if (!this.userAppDb) throw new MasqError(ERRORS.NOT_CONNECTED)
    return this.userAppDb
  }

  _checkDEK () {
    if (!this.dataEncryptionKey) throw Error('Data encryption key is not set')
  }

  async _decryptValue (ciphertext) {
    let decryptedMsg = await common.crypto.decrypt(this.dataEncryptionKey, ciphertext)
    return decryptedMsg
  }

  async _encryptValue (plaintext) {
    let encryptedMsg = await common.crypto.encrypt(this.dataEncryptionKey, plaintext)
    return encryptedMsg
  }

  /**
   * Set a watcher
   * @param {string} key - Key
   * @returns {Object}
   */
  watch (key, cb) {
    const db = this._getDB()
    return db.watch(key, () => cb())
  }

  /**
   * Get a value
   * @param {string} key - Key
   * @returns {Promise}
   */
  async get (key) {
    const db = this._getDB()
    const node = await db.getAsync(key)
    if (!node) return null
    const dec = await this._decryptValue(node.value)
    console.log(dec)
    return dec
    // return node.value
  }

  /**
   * Put a new value in the current profile database
   * @param {string} key - Key
   * @param {string} value - The value to insert
   * @returns {Promise}
   */
  async put (key, value) {
    const db = this._getDB()
    this._checkDEK()
    const enc = await this._encryptValue(value)
    console.log(enc, value)
    return db.putAsync(key, enc)
    // return db.putAsync(key, value)
  }

  /**
   * Delete a key
   * @param {string} key - Key
   * @returns {Promise}
   */
  async del (key) {
    const db = this._getDB()
    this._checkDEK()
    return db.delAsync(key)
  }

  /**
   * List all keys and values
   * @param {string} prefix - Prefix
   * @returns {Promise}
   */
  async list (prefix) {
    const db = this._getDB()
    this._checkDEK()
    const list = await db.listAsync(prefix)
    // console.log(list)

    const dic = {}
    for (let elt of list) {
      dic[elt.key] = await this._decryptValue(elt.value)
    }
    console.log(dic)
    const dic2 = {}
    await Promise.all(list.map(async (elt) => {
      dic[elt.key] = await this._decryptValue(elt.value)
    }))
    console.log(dic2)

    // const reformattedDic = list.reduce((dic, e) => {
    //   const el = Array.isArray(e) ? e[0] : e
    //   dic[el.key] = el.value
    //   return dic
    // }, {})
    // return reformattedDic
    return dic
  }
}

module.exports = Masq
