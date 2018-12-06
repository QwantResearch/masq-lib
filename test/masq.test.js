const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
window.crypto = require('@trust/webcrypto')

const Masq = require('../src')
const MasqAppMock = require('./mockMasqApp')
const config = require('../config/config')

const APP_NAME = 'app1'
const APP_DESCRIPTION = 'A wonderful app'
const APP_IMAGE_URL = ' a link to image'

// user an in memory random-access-storage instead
jest.mock('random-access-idb', () =>
  () => require('random-access-memory'))

jest.mock('../src/utils', () => {
  const original = require.requireActual('../src/utils')
  return {
    ...original,
    dbExists: jest.fn(() => false)
  }
})

let server = null
let masq = null

jest.setTimeout(30000)

beforeAll(async () => {
  server = signalserver()
  await new Promise((resolve) => {
    server.listen(8080, (err) => {
      if (err) throw err
      resolve()
    })
  })
  masq = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
})

afterAll((done) => {
  server.close(done)
})

afterEach(async () => {
  await masq.signout()
})

function getHashParams (url) {
  const hash = url.hash.slice(2)
  const hashParamsArr = JSON.parse(Buffer.from(hash, 'base64').toString('utf8'))
  const hashParamsObj = {
    appName: hashParamsArr[0],
    requestType: hashParamsArr[1],
    channel: hashParamsArr[2],
    key: hashParamsArr[3]
  }
  hashParamsObj.key = Buffer.from(hashParamsObj.key, 'base64')
  return hashParamsObj
}

test('should generate a pairing link', async () => {
  const uuidSize = 36
  const { link, channel } = await masq.logIntoMasq()
  const url = new URL(link)
  let base = config.MASQ_APP_BASE_URL
  expect(url.origin + url.pathname).toBe(base)
  const hashParams = getHashParams(url)
  expect(hashParams.channel).toHaveLength(uuidSize)
  expect(hashParams.channel).toBe(channel)
})

test('should join a channel', async () => {
  expect.assertions(1)

  const pr = new Promise(async (resolve, reject) => {
    const { channel } = await masq.logIntoMasq()

    // simulating masq app
    const hub = signalhub(channel, config.HUB_URLS)
    const sw = swarm(hub, { wrtc })

    sw.on('peer', (peer, id) => {
      expect(sw.peers).toHaveLength(1)
      sw.close()
    })

    sw.on('close', () => {
      resolve()
    })
  })
  await pr
  await masq.logIntoMasqDone()
})

test('should connect to Masq with key passed through url param', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const { link } = await masq.logIntoMasq()
  const url = new URL(link)
  const hashParams = getHashParams(url)

  await Promise.all([
    masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
    masq.logIntoMasqDone()
  ])

  expect(masq.isLoggedIn()).toBe(true)
})

test('should be able to connect with new Masq instance after logging in with stayConnected and disconnecting', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const { link } = await masq.logIntoMasq(true)
  const url = new URL(link)
  const hashParams = getHashParams(url)

  await Promise.all([
    masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
    masq.logIntoMasqDone()
  ])

  const key = '/hello'
  const value = { data: 'world' }
  await masq.put(key, value)
  const res = await masq.get(key)
  expect(res).toEqual(value)

  expect(masq.isLoggedIn()).toBe(true)
  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  // reconnect with new Masq instance
  const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
  expect(masq2.isLoggedIn()).toBe(true)
  expect(masq2.isConnected()).toBe(false)
  await masq2.connectToMasq()
  expect(masq2.isLoggedIn()).toBe(true)
  expect(masq2.isConnected()).toBe(true)
  const key2 = '/hello2'
  const value2 = { data: 'world2' }
  await masq2.put(key2, value2)
  expect(await masq2.get(key2)).toEqual(value2)

  // signout
  await masq2.signout()

  // fail to reconnect without logging in
  const masq3 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
  expect(masq3.isLoggedIn()).toBe(false)
  expect(masq3.isConnected()).toBe(false)
  await masq3.signout()
})

test('should not be able to connect with new Masq instance after logging in without stayConnected and disconnecting', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const { link } = await masq.logIntoMasq(true)
  const url = new URL(link)
  const hashParams = getHashParams(url)

  await Promise.all([
    masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
    masq.logIntoMasqDone()
  ])

  expect(masq.isLoggedIn()).toBe(true)
  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  // reconnect with new Masq instance
  const masq2 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
  expect(masq2.isLoggedIn()).toBe(true)
  expect(masq2.isConnected()).toBe(false)
  await masq2.connectToMasq()
  expect(masq2.isLoggedIn()).toBe(true)
  expect(masq2.isConnected()).toBe(true)
  const key = '/hello'
  const value = { data: 'world' }
  await masq2.put(key, value)
  const res = await masq2.get('/hello')
  expect(res).toEqual(value)

  // signout
  await masq2.signout()

  // fail to reconnect without logging in
  const masq3 = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
  expect(masq3.isLoggedIn()).toBe(false)
  expect(masq3.isConnected()).toBe(false)
  await masq3.signout()
})

test('should be able to put and get values after connect', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const { link } = await masq.logIntoMasq()
  const url = new URL(link)
  const hashParams = getHashParams(url)

  await Promise.all([
    masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
    masq.logIntoMasqDone()
  ])

  const key = '/hello'
  const value = { data: 'world' }
  await masq.put(key, value)
  const res = await masq.get('/hello')
  expect(res).toEqual(value)

  expect(masq.isLoggedIn()).toBe(true)
})

test('should be able to repeat login-disconnect-connect-signout', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const login = async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)

    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasqDone()
    ])
  }

  for (let i = 0; i < 5; i++) {
    await login()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    const key = '/hello'
    const value = { data: 'world' }
    await masq.put(key, value)
    const res = await masq.get('/hello')
    expect(res).toEqual(value)

    await masq.disconnect()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(false)

    try {
      await masq.put(key, value)
    } catch (err) {
      expect(err.message).toEqual('Not connected to Masq')
    }

    await masq.connectToMasq()
    expect(masq.isLoggedIn()).toBe(true)
    expect(masq.isConnected()).toBe(true)

    await masq.signout()
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  }
})

test('should fail when connect without prior login', async () => {
  expect.assertions(12)
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const login = async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)

    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasqDone()
    ])
  }

  try {
    await masq.connectToMasq()
  } catch (err) {
    expect(err.message).toBe('Not logged into Masq')
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  }

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  await masq.connectToMasq()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.signout()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)
})

test('should fail when connect after signout without prior login', async () => {
  expect.assertions(12)
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const login = async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)

    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasqDone()
    ])
  }

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  await masq.connectToMasq()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.signout()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)

  try {
    await masq.connectToMasq()
  } catch (err) {
    expect(err.message).toBe('Not logged into Masq')
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  }
})

test('should be able to disconnect even if not logged in or connected', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const login = async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)

    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasqDone()
    ])
  }

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  await masq.connectToMasq()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.signout()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)
})

test('should be able to disconnect more than once without error', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const login = async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)

    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasqDone()
    ])
  }

  try {
    await masq.connectToMasq()
  } catch (err) {
    expect(err.message).toBe('Not logged into Masq')
    expect(masq.isLoggedIn()).toBe(false)
    expect(masq.isConnected()).toBe(false)
  }

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  await masq.connectToMasq()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.signout()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)
})

test('should be able to connect more than once without error', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const login = async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)

    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasqDone()
    ])
  }

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  await masq.connectToMasq()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.connectToMasq()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.signout()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)
})

test('should be able to sign out more than once without error', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const login = async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)

    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasqDone()
    ])
  }

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  await masq.connectToMasq()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.signout()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)

  await masq.signout()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)
})

test('should be able to login more than once without error', async () => {
  expect(masq.isLoggedIn()).toBe(false)

  const masqAppMock = new MasqAppMock()

  const login = async () => {
    const { link } = await masq.logIntoMasq()
    const url = new URL(link)
    const hashParams = getHashParams(url)

    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key),
      masq.logIntoMasqDone()
    ])
  }

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await login()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.disconnect()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(false)

  await masq.connectToMasq()
  expect(masq.isLoggedIn()).toBe(true)
  expect(masq.isConnected()).toBe(true)

  await masq.signout()
  expect(masq.isLoggedIn()).toBe(false)
  expect(masq.isConnected()).toBe(false)
})

test('should be kicked if key is invalid', async () => {
  expect.assertions(2)

  const masqAppMock = new MasqAppMock()

  const { link } = await masq.logIntoMasq()
  const url = new URL(link)
  const hashParams = getHashParams(url)
  const wrongRawKey = 'wrongChallenge'
  try {
    await Promise.all([
      masqAppMock.handleConnectionAuthorized(hashParams.channel, wrongRawKey),
      masq.logIntoMasqDone()
    ])
  } catch (err) {
    expect(err).toBeDefined()
    expect(err.message).toBe('Invalid Key')
  }
})

test('should fail when register is refused', async () => {
  const masqAppMock = new MasqAppMock()

  const { link } = await masq.logIntoMasq()
  const url = new URL(link)
  const hashParams = getHashParams(url)
  await masqAppMock.handleConnectionRegisterRefused(hashParams.channel, hashParams.key)
  expect.assertions(1)
  try {
    await masq.logIntoMasqDone()
  } catch (e) {
    expect(e.message).toBe('Masq access refused by the user')
  }
})

// TODO add tests for unexpected message received
// TODO add tests for connect-disconnect-connect

async function _initMasqDB () {
  const masqAppMock = new MasqAppMock()
  const { link } = await masq.logIntoMasq()
  const url = new URL(link)
  const hashParams = getHashParams(url)
  await masqAppMock.handleConnectionAuthorized(hashParams.channel, hashParams.key)
  await masq.logIntoMasqDone()
}

test('put/get should put and get an item', async () => {
  expect.assertions(1)
  await _initMasqDB()
  const key = '/hello'
  const value = { data: 'world' }
  await masq.put(key, value)
  const res = await masq.get('/hello')
  expect(res).toEqual(value)
})

test('del should del an item', async () => {
  expect.assertions(1)
  await _initMasqDB()
  const key = '/hello'
  const value = { data: 'world' }
  await masq.put(key, value)
  await masq.del(key)
  const res = await masq.get('/hello')
  expect(res).toBeUndefined()
})

test('should set a watcher', async (done) => {
  expect.assertions(1)
  const onChange = () => {
    expect(true).toBe(true)
    done()
  }
  await _initMasqDB()
  const key = '/hello'
  const value = { data: 'world' }
  masq.watch('/hello', onChange)
  await masq.put(key, value)
})
