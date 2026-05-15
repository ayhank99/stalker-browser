var fs = require('fs');
var path = require('path');
var dotenv = require('dotenv');

[
  '.env.local',
  '.env'
].forEach(function(fileName) {
  var fullPath = path.join(__dirname, fileName);
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override: false });
  }
});
