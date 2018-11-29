const promisifyAll = require('bluebird').promisifyAll
const hyperdb = require('hyperdb')
const rai = require('random-access-idb')

module.exports = {
  dbReady,
  dbExists,
  createPromisifiedHyperDB
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
    let req = window.indexedDB.open(dbName)
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
