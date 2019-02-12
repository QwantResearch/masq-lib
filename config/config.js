let config = {}

switch (process.env.NODE_ENV) {
  case ('development'):
  case ('test'):
    config = require('./config.dev.json')
    config.wrtc = require('wrtc')
    break
  default:
    config = require('./config.prod.json')
    config.wrtc = null
}

module.exports = config
