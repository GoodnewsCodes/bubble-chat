const http = require('http');
const FormData = require('form-data');
const fs = require('fs');

async function test() {
  const form = new FormData();
  form.append('file', Buffer.from('fake image data'), {
    filename: 'test.jpg',
    contentType: 'image/jpeg',
  });

  const req = http.request('http://localhost:3000/api/v1/profile/avatar', {
    method: 'POST',
    headers: form.getHeaders(),
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => console.log('Status code:', res.statusCode, '\nResponse:', data));
  });

  req.on('error', (e) => console.error(e));
  form.pipe(req);
}
test();
