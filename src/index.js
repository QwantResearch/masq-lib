const swarm = require('webrtc-swarm')
const signalhub = require('signalhubws')
const uuidv4 = require('uuid/v4')
const pump = require('pump')

const common = require('masq-common')
const MasqError = common.errors.MasqError
const CURRENT_USER_INFO_STR = 'currentUserInfo'

const jsonConfig = require('../config/config.prod.json')

const debug = (function () {
  switch (process.env.NODE_ENV) {
    case ('development'):
      return console.log
    default:
      return () => { }
  }
})()

class Masq {
  constructor (appName, appDescription, appImageURL, options = {}) {
    this.eventTarget = document.createElement('MasqLib')

    this.appName = appName
    this.appDescription = appDescription
    this.appImageURL = appImageURL

    // override config with constructor options
    this.config = {
      hubUrls: options.hubUrls ? options.hubUrls : jsonConfig.hubUrls,
      masqAppBaseUrl: options.masqAppBaseUrl ? options.masqAppBaseUrl : jsonConfig.masqAppBaseUrl,
      swarmConfig: options.swarmConfig ? options.swarmConfig : jsonConfig.swarmConfig
    }

    // init state
    this.setState('notLogged')

    // init state through async function
    // this.init should be awaited to make sure state is initialized
    this.initPromise = this._init()

    // login state data
    this.stayConnected = false
    this.loginChannel = null
    this.loginKey = null
    this.loginSw = null
    this.loginPeer = null

    // reset replication variables
    this.userAppRepSW = null
    this.userAppRepHub = null

    // setup listeners
    this._listenForLoginOrSignout()
    this._listenForFocus()
  }

  setState (newState) {
    const currState = this.state
    switch (newState) {
      case 'notLogged':
        break
      case 'userAppDbCreated':
        break
      case 'accessMaterialReceived':
        break
      case 'registerNeeded':
        break
      case 'authorized':
        break
      case 'loggingIn':
        break
      case 'logged':
        if (currState !== 'notLogged' &&
            currState !== 'authorized' &&
            currState !== 'userAppDbCreated' &&
            currState !== 'replicating') {
          throw new MasqError(
            MasqError.INVALID_STATE_TRANSITION,
            'state transition invalid: ' + currState + ' -> ' + newState)
        }
        // dispatch event logged_in if the transition is not from replicating
        if (currState !== 'replicating') {
          debug('[masq.setState] dispatched event: logged_in')
          this.eventTarget.dispatchEvent(new Event('logged_in'))
        }
        break
      case 'replicating':
        break
      default:
        throw new MasqError()
    }
    debug('[masq.setState] changing state : ' + currState + ' -> ' + newState)
    this.state = newState
  }

  async init () {
    await this.initPromise
  }

  async _init () {
    // try to login from session info
    await this._loadSessionInfo()

    // get login channel and key created at login link generation
    // sets this.loginKey and this.loginChannel
    // TODO check login link lifecycle
    await this._genLoginLink()
  }

  _listenForLoginOrSignout () {
    window.addEventListener('storage', async (e) => {
      if (e.key === CURRENT_USER_INFO_STR) {
        if (e.newValue === null) {
          if (this.isLoggedIn()) {
            await this.signout()
          }
        } else if (e.newValue) {
          await this._loadSessionInfo()
          debug('[masq._listenForLoginOrSignout] dispatch logged_in')
          this.eventTarget.dispatchEvent(new Event('logged_in'))
        }
      }
    })
  }

  _listenForFocus () {
    document.addEventListener('focus', async () => {
      // try to reopen db
      if (!this.isLoggedIn()) {
        return
      }
      await this._openDb()
      this.startReplication()
    })
  }

  async _loadSessionInfo () {
    const auxLoginFromUserInfo = async (currentUserInfo) => {
      const { userAppDbId, userAppDEK, userAppNonce } = JSON.parse(currentUserInfo)
      this.userAppDbId = userAppDbId
      this.userAppDEK = userAppDEK
      this.importedUserAppDEK = await common.crypto.importKey(Buffer.from(userAppDEK, 'hex'))
      this.userAppNonce = userAppNonce
      this.setState('logged')
      await this._openDb()
      this.startReplication()
    }

    // If user info is stored in session storage, do not use localStorage
    const currentUserInfo = window.sessionStorage.getItem(CURRENT_USER_INFO_STR)
    if (currentUserInfo) {
      await auxLoginFromUserInfo(currentUserInfo)
      return
    }

    // if userId is is not in session storage, look for it in local storage
    // and save in session storage
    const localStorageCurrentUserInfo = window.localStorage.getItem(CURRENT_USER_INFO_STR)
    if (localStorageCurrentUserInfo) {
      await auxLoginFromUserInfo(localStorageCurrentUserInfo)
      window.sessionStorage.setItem(CURRENT_USER_INFO_STR, localStorageCurrentUserInfo)
    }
  }

  async _openDb () {
    try {
      this.userAppDb = common.utils.createPromisifiedHyperDB(this.userAppDbId)
      await common.utils.dbReady(this.userAppDb)
    } catch (e) {
      if (this.isLoggedIn()) {
        throw e
      }
    }
  }

  _createSwarm (hub) {
    return swarm(hub, {
      config: this.config.swarmConfig
    })
  }

  startReplication () {
    debug('[masq.startReplication]')
    if (this.state !== 'logged') {
      return
    }

    try {
      this.userAppDb.discoveryKey.toString('hex')
    } catch (e) {
      console.error(e)
    }
    const discoveryKey = this.userAppDb.discoveryKey.toString('hex')
    this.userAppRepHub = signalhub(discoveryKey, this.config.hubUrls)
    this.userAppRepSW = this._createSwarm(this.userAppRepHub)

    this.setState('replicating')
    this.userAppRepSW.on('peer', (peer, id) => {
      try {
        const stream = this.userAppDb.replicate({ live: true })
        pump(peer, stream, peer)
      } catch (e) {
        if (this.isLoggedIn()) {
          throw e
        }
      }
    })
  }

  async stopReplication () {
    debug('[masq.stopReplication]')
    await new Promise((resolve) => {
      if (!this.userAppRepSW) {
        resolve()
      }
      this.userAppRepSW.close(() => {
        resolve()
      })
    })

    // reset replication variables
    this.userAppRepSW = null
    this.userAppRepHub = null

    if (this.state === 'replicating') {
      this.setState('logged')
    }
  }

  isReplicating () {
    return (this.state === 'replicating')
  }

  isLoggedIn () {
    return (this.state === 'logged' || this.state === 'replicating')
  }

  async getUsername () {
    const currentUserInfo = window.sessionStorage.getItem(CURRENT_USER_INFO_STR)
    if (!currentUserInfo) return null
    return JSON.parse(currentUserInfo).username
  }

  async getProfileImage () {
    const currentUserInfo = window.sessionStorage.getItem(CURRENT_USER_INFO_STR)
    if (!currentUserInfo) return null
    return JSON.parse(currentUserInfo).profileImage
  }

  async _genLoginLink () {
    this.loginChannel = uuidv4()
    this.loginKey = await common.crypto.genAESKey(true, 'AES-GCM', 128)
    const extractedKey = await common.crypto.exportKey(this.loginKey)
    const keyBase64 = Buffer.from(extractedKey).toString('base64')
    this.loginUrl = new URL(this.config.masqAppBaseUrl)
    const requestType = 'login'
    const hashParams = JSON.stringify([this.appName, requestType, this.loginChannel, keyBase64])
    this.loginUrl.hash = '/link/' + Buffer.from(hashParams).toString('base64')

    this.loginLink = this.loginUrl.href
  }

  async getLoginLink () {
    return this.loginLink
  }

  async logIntoMasq (stayConnected) {
    this.setState('loggingIn')

    // make stayConnected i boolean
    this.stayConnected = !!stayConnected

    let pr = new Promise((resolve, reject) => {
      // Subscribe to channel for a limited time to sync with masq
      debug(`Creation of a hub with ${this.loginChannel} channel name`)

      const hub = signalhub(this.loginChannel, this.config.hubUrls)
      hub.on('error', ({ url, error }) => {
        reject(new MasqError(MasqError.SIGNALLING_SERVER_ERROR, url, error))
      })

      this.loginSw = this._createSwarm(hub)

      let dataReceived = false

      this.loginSw.on('peer', (peer, id) => {
        debug(`The peer ${id} join us...`)
        this.loginPeer = peer

        this.loginPeer.once('data', async (data) => {
          dataReceived = true
          try {
            // decrypt the received message and check if the right key has been used
            const json = await common.crypto.decrypt(this.loginKey, JSON.parse(data), 'base64')
            // this._checkMessage(json, registering, waitingForWriteAccess)

            switch (json.msg) {
              case 'authorized':
                await this._receivedAuthorized(json)
                break

              case 'notAuthorized':
                // if this User-app is not registered
                await this._receiveNotAuthorized()
                break

              default:
                // TODO change error
                throw new MasqError(MasqError.WRONG_MESSAGE, `Unexpectedly received message with type ${json.code}`)
            }
            resolve()
          } catch (e) {
            await this._resetLogin()
            reject(e)
          }
        })

        this.loginSw.on('disconnect', async (peer, id) => {
          debug('[masq.logIntoMasq] disconnect')
          if (!dataReceived) {
            reject(new MasqError(MasqError.DISCONNECTED_DURING_LOGIN))
          }
        })

        this.loginSw.on('close', () => {
          debug('[masq.logIntoMasq] close')
        })
      })
    })

    try {
      await pr
      this.loginSw.close()
    } catch (e) {
      await this._resetLogin()
      throw e
    }
  }

  async _resetLogin () {
    this._deleteSessionInfo()

    // clear state
    this.stayConnected = false
    this.loginChannel = null
    this.loginKey = null
    this.loginUrl = null
    if (this.loginSw) {
      if (!this.loginSw.closed) {
        await new Promise((resolve) => {
          this.loginSw.close(() => {
            resolve()
          })
        })
      }
    }
    this.loginSw = null
    this.loginPeer = null
    this.username = null
    this.profileImage = null
    this.userAppDbId = null
    this.userAppDEK = null
    this.importedUserAppDEK = null
    this.userAppNonce = null
    this.userAppDb = null

    await this.stopReplication()

    await this._genLoginLink()

    this.setState('notLogged')
  }

  async _receivedAuthorized (json) {
    debug('[masq._receiveAuthorized]')
    this.setState('authorized')

    // TODO checkMessage

    const userAppDbId = json.userAppDbId

    // Check if the User-app is already registered
    if (await common.utils.dbExists(userAppDbId)) {
      await this._dbExists(json)
    } else {
      await this._dbUnknown()
    }
  }

  async _dbExists (json) {
    debug('[masq._dbExists]')

    // TODO checkMessage

    // Store the session info and read into this state
    this._storeSessionInfo(this.stayConnected, json)

    this.userAppDb = common.utils.createPromisifiedHyperDB(this.userAppDbId)
    await common.utils.dbReady(this.userAppDb)

    const encryptedMsg = await common.crypto.encrypt(
      this.loginKey,
      { msg: 'connectionEstablished' },
      'base64'
    )
    this.loginPeer.send(JSON.stringify(encryptedMsg))

    this.setState('logged')

    // TODO make sure try/catch is not needed
    this.startReplication()
  }

  async _storeSessionInfo (stayConnected, userInfoJson) {
    const { userAppDbId, userAppDEK, userAppNonce, username, profileImage } = userInfoJson
    this.username = username
    this.profileImage = profileImage

    this.userAppDbId = userAppDbId
    this.userAppDEK = userAppDEK

    if (userAppDEK) {
      // store the dataEncryptionKey as a CryptoKey
      this.importedUserAppDEK = await common.crypto.importKey(Buffer.from(userAppDEK, 'hex'))
    }

    this.userAppNonce = userAppNonce

    // Store the session info
    const currentUserInfo = {
      userAppDbId: this.userAppDbId,
      userAppDEK: userAppDEK,
      username: this.username,
      profileImage: this.profileImage,
      userAppNonce: this.userAppNonce
    }

    if (stayConnected) {
      window.localStorage.setItem(CURRENT_USER_INFO_STR, JSON.stringify(currentUserInfo))
    }
    window.sessionStorage.setItem(CURRENT_USER_INFO_STR, JSON.stringify(currentUserInfo))
  }

  _deleteSessionInfo () {
    window.localStorage.removeItem(CURRENT_USER_INFO_STR)
    window.sessionStorage.removeItem(CURRENT_USER_INFO_STR)
  }

  async _dbUnknown () {
    debug('[masq._dbUnknown]')
    await this._registerNeeded()
  }

  async _receiveNotAuthorized () {
    debug('[masq._receiveNotAuthorized]')
    await this._registerNeeded()
  }

  async _registerNeeded () {
    debug('[masq._registerNeeded]')
    this.setState('registerNeeded')

    const msg = {
      msg: 'registerUserApp',
      name: this.appName,
      description: this.appDescription,
      imageURL: this.appImageURL
    }
    let encryptedMsg = await common.crypto.encrypt(this.loginKey, msg, 'base64')
    this.loginPeer.send(JSON.stringify(encryptedMsg))

    const pr = new Promise((resolve, reject) => {
      this.loginPeer.once('data', async (data) => {
        try {
          // decrypt the received message and check if the right key has been used
          const json = await common.crypto.decrypt(this.loginKey, JSON.parse(data), 'base64')
          // this._checkMessage(json, registering, waitingForWriteAccess)

          switch (json.msg) {
            case 'masqAccessGranted':
              await this._registering(json)
              break

            case 'masqAccessRefused':
              await this._userRefusedAccess()
              break

            default:
              throw new MasqError(MasqError.WRONG_MESSAGE, `Unexpectedly received message with type ${json.code}`)
          }
        } catch (err) {
          await this._resetLogin('could not decrypt')
          reject(err)
        }
        resolve()
      })
    })

    await pr
  }

  async _userRefusedAccess () {
    debug('[masq._userRefusedAccess]')
    await this._resetLogin()
    throw new MasqError(MasqError.MASQ_ACCESS_REFUSED_BY_USER)
  }

  async _registering (json) {
    debug('[masq._registering]')
    this.setState('accessMaterialReceived')

    // TODO checkMessage

    // Store the session info and read into this state
    this._storeSessionInfo(this.stayConnected, json)

    const buffKey = Buffer.from(json.key, 'hex')
    const db = common.utils.createPromisifiedHyperDB(json.userAppDbId, buffKey)
    await common.utils.dbReady(db)

    const msg = {
      msg: 'requestWriteAccess',
      key: db.local.key.toString('hex')
    }
    const encryptedMsg = await common.crypto.encrypt(this.loginKey, msg, 'base64')
    this.loginPeer.send(JSON.stringify(encryptedMsg))

    const pr = new Promise((resolve, reject) => {
      this.loginPeer.once('data', async (data) => {
        try {
          // decrypt the received message and check if the right key has been used
          const json = await common.crypto.decrypt(this.loginKey, JSON.parse(data), 'base64')
          // this._checkMessage(json, registering, waitingForWriteAccess)

          switch (json.msg) {
            case 'writeAccessGranted':
              await this._dbCreation()
              break

            default:
              throw new MasqError(MasqError.WRONG_MESSAGE, `Unexpectedly received message with type ${json.code}`)
          }
        } catch (err) {
          await this._resetLogin('could not decrypt')
          reject(err)
        }
        resolve()
      })
    })

    await pr
  }

  async _dbCreation () {
    debug('[masq._dbCreation]')
    this.setState('userAppDbCreated')

    await this._openDb()

    const msg = {
      msg: 'connectionEstablished'
    }
    const encryptedMsg = await common.crypto.encrypt(this.loginKey, msg, 'base64')

    this.loginPeer.send(JSON.stringify(encryptedMsg))

    await this._awaitReadyMsg()
  }

  async _awaitReadyMsg () {
    debug('[masq._awaitReadyMsg]')
    // TODO : should we really await a 'ready' message when register ?
    this.setState('logged')
    this.startReplication()
  }

  async signout () {
    this.userAppDbId = null
    this.userAppDb = null

    await this._resetLogin()

    debug('[masq.signout] dispatched event: signed_out')
    this.eventTarget.dispatchEvent(new Event('signed_out'))
  }

  async watch (key, cb) {
    debug('[masq.watch] logged : ' + this.isLoggedIn())
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    return common.utils.watch(this.userAppDb, this.userAppNonce, key, cb)
  }

  async get (key) {
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    return common.utils.get(this.userAppDb, this.importedUserAppDEK, this.userAppNonce, key)
  }

  async put (key, value) {
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    return common.utils.put(this.userAppDb, this.importedUserAppDEK, this.userAppNonce, key, value)
  }

  async del (key) {
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    const hashedKey = await common.utils.hashKey(key, this.userAppNonce)
    return this.userAppDb.delAsync(hashedKey)
  }

  async list (prefix) {
    if (!this.isLoggedIn()) {
      throw new MasqError(MasqError.NOT_CONNECTED)
    }
    return common.utils.list(this.userAppDb, this.importedUserAppDEK, this.userAppNonce, prefix)
  }
}

module.exports = {
  Masq,
  MasqError
}
