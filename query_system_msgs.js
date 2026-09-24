const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble-chat').then(async () => {
  const db = mongoose.connection.db;
  const msgs = await db.collection('messages').find({ $or: [{ message_type: 'system' }, { is_announcement: true }] }).toArray();
  // console.log("System messages found:", msgs.length);
  msgs.slice(0, 5).forEach(m => console.log(m.content));
  process.exit(0);
});
