const { expect } = require('chai')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const common = require('masq-common')

const Masq = require('../src')
const MasqAppMock = require('./mockMasqApp')
const testConfig = require('../config/config.test.json')

const APP_NAME = 'app1'
const APP_DESCRIPTION = 'A wonderful app'
const APP_IMAGE_URL = ' a link to image'
const TIMEOUT = 20000
const ERRORS = common.errors.ERRORS

const { genRandomBuffer } = common.crypto

let masq = null
let mockMasqApp = null

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
  masq = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
  mockMasqApp = new MasqAppMock()
  await mockMasqApp.init()
})

afterEach(async () => {
  await masq.signout()
  mockMasqApp.destroy()
})

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

describe('Login procedure', function () {
  this.timeout(TIMEOUT)

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

    await Promise.all([waitForPeer, masq.logIntoMasq(false)])
    expect(peersLength).to.equal(1)
  })

  it('isLoggedIn and isConnected should return false', async () => {
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
  })

  it('isLoggedIn and isConnected should return true after successful login', async () => {
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true
  })

  it('should login and signout correctly', async () => {
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
    await logInWithMasqAppMock(true)
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true
    await masq.signout()
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
  })

  it('should be able to connect with new Masq instance after logging in with stayConnected and disconnecting', async () => {
    expect(masq.isLoggedIn()).to.be.false
    await logInWithMasqAppMock(true)

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    const res = await masq.get(key)
    expect(res).to.eql(value)
    expect(masq.isLoggedIn()).to.be.true
    await masq._disconnect()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.false

    // reconnect with new Masq instance
    const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
    expect(masq2.isLoggedIn()).to.be.true
    expect(masq2.isConnected()).to.be.false
    await masq2.connectToMasq()
    expect(masq2.isLoggedIn()).to.be.true
    expect(masq2.isConnected()).to.be.true
    const key2 = '/hello2'
    const value2 = { data: 'world2' }
    await masq2.put(key2, value2)
    expect(await masq2.get(key2)).to.eql(value2)

    // signout
    await masq2.signout()
  })

  it('should not be able to connect with new Masq instance after logging in without stayConnected and disconnecting', async () => {
    let err
    expect(masq.isLoggedIn()).to.be.false
    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    await masq._disconnect()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.false

    // reconnect with new Masq instance (masq2)
    const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL, testConfig)
    expect(masq2.isLoggedIn()).to.be.false
    expect(masq2.isConnected()).to.be.false

    try {
      await masq2.connectToMasq()
    } catch (e) {
      err = e
    }
    expect(err.type).to.equal(ERRORS.NOT_LOGGED_IN)

    expect(masq2.isLoggedIn()).to.be.false
    expect(masq2.isConnected()).to.be.false

    // connect with masq2
    mockMasqApp.destroy()
    const link = await masq2.getLoginLink()
    const hashParams = getHashParams(link)
    await Promise.all([
      mockMasqApp.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq2.logIntoMasq(false)
    ])

    expect(masq2.isLoggedIn()).to.be.true
    expect(masq2.isConnected()).to.be.true

    // put with masq2
    const key = '/hello'
    const value = { data: 'world' }
    await masq2.put(key, value)
    const res = await masq2.get('/hello')
    expect(res).to.eql(value)

    // signout with masq2
    await masq2.signout()
  })

  it('should be able to repeat login-disconnect-connect-signout', async () => {
    expect(masq.isLoggedIn()).to.be.false

    for (let i = 0; i < 2; i++) {
      await logInWithMasqAppMock(false)
      expect(masq.isLoggedIn()).to.be.true
      expect(masq.isConnected()).to.be.true

      await masq._disconnect()
      expect(masq.isLoggedIn()).to.be.true
      expect(masq.isConnected()).to.be.false

      await masq.connectToMasq()
      expect(masq.isLoggedIn()).to.be.true
      expect(masq.isConnected()).to.be.true

      await masq.signout()
      expect(masq.isLoggedIn()).to.be.false
      expect(masq.isConnected()).to.be.false
    }
  })

  it('should fail when connect without prior login', async () => {
    let err
    expect(masq.isLoggedIn()).to.be.false
    try {
      await masq.connectToMasq()
    } catch (e) {
      err = e
    }
    expect(err.type).to.equal(ERRORS.NOT_LOGGED_IN)

    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
  })

  it('should fail when connect after signout without prior login', async () => {
    let err
    expect(masq.isLoggedIn()).to.be.false

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true

    await masq._disconnect()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.false

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true

    await masq.signout()
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false

    // Trying to reconnect without login should fail
    try {
      await masq.connectToMasq()
    } catch (e) {
      err = e
    }

    expect(err.type).to.equal(ERRORS.NOT_LOGGED_IN)
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
  })

  it('should be able to disconnect even if not logged in nor connected', async () => {
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
    await masq._disconnect()
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
  })

  it('should be able to disconnect more than once, then reconnect without error', async () => {
    expect(masq.isLoggedIn()).to.be.false

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true

    await masq._disconnect()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.false

    await masq._disconnect()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.false

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true
  })

  it('should be able to connect more than once without error', async () => {
    expect(masq.isLoggedIn()).to.be.false

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true

    await masq._disconnect()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.false

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true
  })

  it('should be able to sign out more than once without error', async () => {
    expect(masq.isLoggedIn()).to.be.false

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true

    await masq.signout()
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false

    await masq.signout()
    expect(masq.isLoggedIn()).to.be.false
    expect(masq.isConnected()).to.be.false
  })

  it('should be able to login more than once without error', async () => {
    expect(masq.isLoggedIn()).to.be.false

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true

    await logInWithMasqAppMock(false)
    expect(masq.isLoggedIn()).to.be.true
    expect(masq.isConnected()).to.be.true
  })

  it('should be kicked if key is invalid', async () => {
    let err
    const link = await masq.getLoginLink()
    const hashParams = getHashParams(link)
    const invalidKey = 'wrongChallenge'

    const promiseAll = Promise.all([
      mockMasqApp.handleConnectionAuthorized(hashParams.channel, invalidKey),
      masq.logIntoMasq(false)
    ])

    try {
      await promiseAll
    } catch (e) {
      err = e
    }
    expect(err.type).to.equal(ERRORS.INVALID_KEY)
  })

  it('should be kicked if wrong key is used', async () => {
    let err
    const link = await masq.getLoginLink()
    const hashParams = getHashParams(link)
    // Extracted raw key is only a BUffer of bytes.
    const extractedWrongKey = Buffer.from(genRandomBuffer(16))
    const promiseAll = Promise.all([
      mockMasqApp.handleConnectionAuthorized(hashParams.channel, extractedWrongKey),
      masq.logIntoMasq(false)
    ])

    try {
      await promiseAll
    } catch (e) {
      err = e
    }
    expect(err.type).to.equal(ERRORS.UNABLE_TO_DECRYPT)
  })

  it('should fail when register is refused', async () => {
    let err
    const link = await masq.getLoginLink()
    const hashParams = getHashParams(link)

    const promiseAll = Promise.all([
      mockMasqApp.handleConnectionRegisterRefused(hashParams.channel, hashParams.key),
      masq.logIntoMasq(false)
    ])

    try {
      await promiseAll
    } catch (e) {
      err = e
    }
    expect(err.type).to.equal(ERRORS.MASQ_ACCESS_REFUSED_BY_USER)
  })
})

// // TODO add tests for unexpected message received
// // TODO add tests for connect-disconnect-connect

describe('Test data access and input', function () {
  this.timeout(TIMEOUT)

  it('operations should fail if masq is not connected', (done) => {
    let count = 0
    const promises = [
      masq.watch('key'),
      masq.get('key'),
      masq.put('key', 'value'),
      masq.del('key'),
      masq.list('/')
    ]

    for (let p of promises) {
      p.catch((e) => {
        expect(e.type).to.equal(ERRORS.NOT_CONNECTED)
        if (++count === promises.length) done()
      })
    }
  })

  it('put/get should put and get an item', async () => {
    await logInWithMasqAppMock(false)
    const key = '/hello'
    const value = { data: 'world' }

    await masq.put(key, value)
    const res = await masq.get('/hello')

    expect(res).to.eql(value)
  })

  // // By default hyperDB list method returns key="" value=null if no put has been done
  it('list should return {} if empty (with no parameter)', async () => {
    await logInWithMasqAppMock(false)
    const res = await masq.list()
    expect(res).to.eql({})
  })

  // By default hyperDB list method returns key="" value=null if no put has been done
  it('list should return {} if empty (with "/" as parameter)', async () => {
    await logInWithMasqAppMock(false)
    const res = await masq.list()
    expect(res).to.eql({})
  })

  it('list should get every put items', async () => {
    await logInWithMasqAppMock(false)
    const keyValues = {
      'hello': { data: 'world' },
      'hello1': { data: 'world1' },
      'hello2': { data: 'world2' },
      'hello3': { data: 'world3' }
    }
    const promiseArr = Object.keys(keyValues).map(k =>
      masq.put(k, keyValues[k])
    )
    await Promise.all(promiseArr)
    await masq.del('hello2')
    const res = await masq.list('/')

    const expected = Object.keys(keyValues).reduce((dic, k) => {
      if (k !== 'hello2') dic[k] = keyValues[k]
      return dic
    }, {})

    expect(res).to.eql(expected)
  })

  it('del should del an item', async () => {
    await logInWithMasqAppMock(false)
    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    await masq.del(key)
    const res = await masq.get('/hello')
    expect(res).to.be.null
  })

  it('should set a watcher', async () => {
    let resolveOnChange
    const waitForChange = new Promise((resolve) => { resolveOnChange = resolve })

    await logInWithMasqAppMock(false)
    const key = '/hello'
    const value = { data: 'world' }
    masq.watch('/hello', resolveOnChange)
    await masq.put(key, value)
    await waitForChange
  })

  it('should be able to get a notif on change in masq-app with a watcher on masq-lib', async () => {
    let resolveOnChange
    const waitForChange = new Promise((resolve) => { resolveOnChange = resolve })

    await logInWithMasqAppMock(false)
    const key = '/hello'
    const value = { data: 'world' }
    masq.watch('/hello', resolveOnChange)
    await mockMasqApp.put(masq.userId, key, value)
    await waitForChange
  })
})

describe('Test replication', function () {
  this.timeout(TIMEOUT)
  it('put/get should put an item and get in Mock Masq App', async () => {
    await logInWithMasqAppMock(false)

    let resolveOnChange
    const waitForChange = new Promise((resolve) => { resolveOnChange = resolve })
    mockMasqApp.watch(masq.userId, '/hello', resolveOnChange)

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    await waitForChange
    const res = await mockMasqApp.get(masq.userId, '/hello')
    // Because we hash the keys, we include the key name inside the value
    const expected = { 'key': 'hello', 'value': { 'data': 'world' } }

    expect(res).to.eql(expected)
  })
})
