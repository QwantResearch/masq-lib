const promisifyAll = require('bluebird').promisifyAll
const hyperdb = require('hyperdb')
const rai = require('random-access-idb')

module.exports = {
  dbReady,
  dbExists,
  createPromisifiedHyperDB,
  encryptMessage,
  decryptMessage
}

function createPromisifiedHyperDB (name, hexKey) {
  const keyBuffer = hexKey
    ? Buffer.from(hexKey, 'hex')
    : null
  return promisifyAll(hyperdb(rai(name), keyBuffer, { valueEncoding: 'json' }))
}

function dbReady (db) {
  return new Promise((resolve, reject) => {
    db.on('ready', () => {
      resolve()
    })
  })
}

function dbExists (dbName) {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(dbName)
    let existed = true
    req.onsuccess = () => {
      req.result.close()
      if (!existed) { window.indexedDB.deleteDatabase(dbName) }
      resolve(existed)
    }
    req.onupgradeneeded = () => {
      existed = false
    }
    req.onerror = (err) => {
      reject(err)
    }
  })
}

function genIV () {
  const ivLen = 16

  const initializationVector = new Uint8Array(ivLen)
  window.crypto.getRandomValues(initializationVector)
  return initializationVector
}

async function encryptMessage (key, data) {
  const strData = JSON.stringify(data)
  const bufferData = Buffer.from(strData, 'utf8')
  const iv = genIV()
  const encrypted = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    bufferData)
  const encryptedBase64 = Buffer.from(encrypted).toString('base64')
  const ivBase64 = Buffer.from(iv).toString('base64')
  return JSON.stringify({
    encrypted: encryptedBase64,
    iv: ivBase64
  })
}

async function decryptMessage (key, data) {
  const encryptedJson = JSON.parse(data)
  const iv = Buffer.from(encryptedJson.iv, 'base64')
  const encryptedData = Buffer.from(encryptedJson.encrypted, 'base64')
  const decryptedData = await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    encryptedData
  )
  const decryptedDataBuffer = decryptedData
  const decryptedJson = JSON.parse(Buffer.from(decryptedDataBuffer).toString('utf8'))
  return decryptedJson
}
