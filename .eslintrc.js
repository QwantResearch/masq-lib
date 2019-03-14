module.exports = {
  extends: ['standard'],
  plugins: ['mocha'],
  env: {
    'browser': true,
    'mocha': true
  },
  overrides: [{
    files: '*.test.js',
    rules: {
      'no-unused-expressions': 'off'
    }
  }]
}
