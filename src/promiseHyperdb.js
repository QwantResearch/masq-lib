module.exports = {
  get,
  batch,
  put,
  del,
  ready,
  dbExists
}

function get (db, path) {
  return new Promise((resolve, reject) => {
    db.get(path, (err, node) => {
      if (err) return reject(err)
      return resolve(node)
    })
  })
}

function batch (db, batch) {
  return new Promise((resolve, reject) => {
    db.batch(batch, (err) => {
      if (err) return reject(err)
      return resolve()
    })
  })
}

function put (db, path, obj) {
  return new Promise((resolve, reject) => {
    db.put(path, obj, (err) => {
      if (err) return reject(err)
      return resolve()
    })
  })
}

function del (db, path) {
  return new Promise((resolve, reject) => {
    db.del(path, (err, node) => {
      if (err) return reject(err)
      return resolve(node)
    })
  })
}

function ready (db) {
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
