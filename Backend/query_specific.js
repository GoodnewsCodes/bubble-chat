const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble-chat').then(async () => {
  const db = mongoose.connection.db;
  const msgs = await db.collection('messages').find({ content: { $regex: /Meeting Scheduled|Bubble call/i } }).toArray();
  // console.log("Found:", msgs.length);
  msgs.forEach(m => console.log(m.content, m.message_type, m.is_announcement));
  process.exit(0);
});
