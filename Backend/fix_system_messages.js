const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble-chat').then(async () => {
  const db = mongoose.connection.db;

  // 1. Mark existing task messages as system messages
  const updateResult = await db.collection('messages').updateMany(
    { content: { $regex: /Meeting Scheduled|Bubble call/i } },
    { $set: { message_type: 'system', is_announcement: true } }
  );
  // // console.log(`Updated ${updateResult.modifiedCount} text messages to system messages.`);

  // 2. Fix the latestMessage pointer for all conversations
  const conversations = await db.collection('conversations').find({}).toArray();
  let fixedCount = 0;

  for (const conv of conversations) {
    // Find the latest non-system message
    const lastRealMsg = await db.collection('messages').find({
      chat: conv._id,
      message_type: { $ne: 'system' },
      is_announcement: { $ne: true }
    }).sort({ createdAt: -1 }).limit(1).toArray();

    const newLatest = lastRealMsg.length > 0 ? lastRealMsg[0]._id : null;
    const oldLatest = conv.latestMessage ? conv.latestMessage.toString() : null;

    if (newLatest && newLatest.toString() !== oldLatest) {
      await db.collection('conversations').updateOne(
        { _id: conv._id },
        { $set: { latestMessage: newLatest } }
      );
      fixedCount++;
    } else if (!newLatest && oldLatest) {
      await db.collection('conversations').updateOne(
        { _id: conv._id },
        { $unset: { latestMessage: "" } }
      );
      fixedCount++;
    }
  }

  // // console.log(`Fixed latestMessage pointers for ${fixedCount} conversations.`);
  process.exit(0);
});
