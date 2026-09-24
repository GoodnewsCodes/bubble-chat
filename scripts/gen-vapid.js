const wp = require('web-push');
const keys = wp.generateVAPIDKeys();
console.log('PUBLIC_KEY=' + keys.publicKey);
console.log('PRIVATE_KEY=' + keys.privateKey);
