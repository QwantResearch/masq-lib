let config = {}

switch (process.env.NODE_ENV) {
  case ('development'):
  case ('test'):
    config = require('./config.dev.json')
    break
  default:
    config = require('./config.prod.json')
}

module.exports = config
