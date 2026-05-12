module.exports = {
  transform: {
    "^.+\\.js$": "babel-jest"
  },
  testEnvironment: "node",
  transformIgnorePatterns: [ "node_modules/(?!(dexie|fake-indexeddb)/)" ],
  testMatch: [ "**/test/**/*.js" ],
  collectCoverageFrom: [ "src/**/*.js" ],
  setupFilesAfterEnv: [ "<rootDir>/jest.setup.js" ]
};
