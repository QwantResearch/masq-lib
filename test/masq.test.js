const { expect } = require('chai')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const common = require('masq-common')
const MasqError = common.errors.MasqError

const Masq = require('../src').Masq
const MasqAppMock = require('./mockMasqApp')
const testConfig = require('../config/config.test.json')

const APP_NAME = 'app1'
const APP_DESCRIPTION = 'A wonderful app'
const APP_IMAGE_URL = ' a link to image'
const TIMEOUT = 1000000

let masq = null
let mockMasqApp = null

describe('localStorage and sessionStorage', () => {
  it('check that localStorage exists', () => {
    window.localStorage.setItem('testKey', 'testValue')
    expect(window.localStorage.getItem('testKey')).to.equal('testValue')
    window.localStorage.clear()
  })

  it('check that sessionStorage exists', () => {
    window.sessionStorage.setItem('testKey', 'testValue')
    expect(window.sessionStorage.getItem('testKey')).to.equal('testValue')
    window.sessionStorage.clear()
  })
})

describe('Test data access and input', function () {
  this.timeout(TIMEOUT)

  function getHashParams (link) {
    const url = new URL(link)
    const hash = url.hash.slice(7)
    const hashParamsArr = JSON.parse(Buffer.from(hash, 'base64').toString('utf8'))
    if (!Array.isArray(hashParamsArr) || hashParamsArr.length !== 4) {
      throw new Error('Wrong login URL')
    }
    const hashParamsObj = {
      appName: hashParamsArr[0],
      requestType: hashParamsArr[1],
      channel: hashParamsArr[2],
      key: hashParamsArr[3]
    }
    hashParamsObj.key = Buffer.from(hashParamsObj.key, 'base64')
    return hashParamsObj
  }

  async function logInWithMasqAppMock (stayConnected) {
    // stop replication if logInWithMasqAppMock has already been called
    mockMasqApp.destroy()

    const link = await masq.getLoginLink()
    const hashParams = getHashParams(link)

    await Promise.all([
      mockMasqApp.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasq(stayConnected)
    ])
  }

  beforeEach(async () => {
    console.log('######## BEFORE EACH ########')
    masq = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
    await masq.init()
    mockMasqApp = new MasqAppMock()
    await mockMasqApp.init()
    console.log('######## END BEFORE EACH ########')
  })

  afterEach(async () => {
    console.log('######## AFTER EACH ########')
    await masq.signout()
    mockMasqApp.destroy()
    console.log('######## END AFTER EACH ########')
  })

  it('should generate a pairing link', async () => {
    const uuidSize = 36
    const link = await masq.getLoginLink()
    const url = new URL(link)
    const base = testConfig.masqAppBaseUrl
    expect(url.origin + url.pathname).to.equal(base)
    const hashParams = getHashParams(link)
    expect(hashParams.channel).to.have.lengthOf(uuidSize)
  })

  it('should join a channel', async () => {
    let peersLength

    const waitForPeer = new Promise(async (resolve, reject) => {
      const link = await masq.getLoginLink()
      const hashParams = getHashParams(link)

      // simulating masq app
      const hub = signalhub(hashParams.channel, testConfig.hubUrls)
      const sw = swarm(hub)

      sw.on('peer', (peer, id) => {
        peersLength = sw.peers.length
        sw.close()
      })

      sw.on('close', () => {
        resolve()
      })
    })

    let err
    try {
      await Promise.all([waitForPeer, masq.logIntoMasq(false)])
    } catch (e) {
      err = e
    }
    expect(err.code).to.equal(MasqError.DISCONNECTED_DURING_LOGIN)
    expect(peersLength).to.equal(1)
  })

  it('first login', async () => {
    const stayConnected = false
    await logInWithMasqAppMock(stayConnected)
  })

  it('first login and put data', async () => {
    const stayConnected = false
    await logInWithMasqAppMock(stayConnected)
    await masq.put('/hello', 'world')
    const retrievedValue = await masq.get('/hello')
    expect(retrievedValue).to.eql('world')
  })

  const _deleteSessionStorage = () => {
    const CURRENT_USER_INFO_STR = 'currentUserInfo'
    window.sessionStorage.removeItem(CURRENT_USER_INFO_STR)
  }

  it('signout', async () => {
    expect(masq.isLoggedIn()).to.be.false
    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    await masq.signout()
    expect(masq.isLoggedIn()).to.be.false
  })

  it('second login: login with an already registered UserApp', async () => {
    expect(masq.isLoggedIn()).to.be.false
    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    await masq.signout()
    expect(masq.isLoggedIn()).to.be.false
    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
  })

  it('stayConnected: should be able to connect with new Masq instance after logging in with stayConnected and closing (deleteSessionStorage)', async () => {
    expect(masq.isLoggedIn()).to.be.false
    await logInWithMasqAppMock(true)

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    const res = await masq.get(key)
    expect(res).to.eql(value)
    expect(masq.isLoggedIn()).to.be.true
    await _deleteSessionStorage()

    // reconnect with new Masq instance
    const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
    await masq2.init()
    expect(masq2.isLoggedIn()).to.be.true
    const key2 = '/hello2'
    const value2 = { data: 'world2' }
    await masq2.put(key2, value2)
    expect(await masq2.get(key2)).to.eql(value2)

    // signout
    await masq2.signout()
  })

  it('second login with stayConnected', async () => {
    expect(masq.isLoggedIn()).to.be.false
    await logInWithMasqAppMock(true)
    expect(masq.isLoggedIn()).to.be.true
    await masq.signout()
    expect(masq.isLoggedIn()).to.be.false
    await logInWithMasqAppMock(true)
    expect(masq.isLoggedIn()).to.be.true

    // reconnect with new Masq instance
    await _deleteSessionStorage()
    const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
    await masq2.init()
    expect(masq2.isLoggedIn()).to.be.true
  })
})
