module.exports = {
  extends: ['standard'],
  plugins: ['mocha'],
  env: {
    'mocha': true
  },
  overrides: [{
    files: '*.test.js',
    rules: {
      'no-unused-expressions': 'off'
    }
  }]
}
