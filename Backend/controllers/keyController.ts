import { Response } from 'express';
import { Conversation } from '../models/conversations';
import { ConversationKey } from '../models/conversationKey';
import { User } from '../models/users';
import { getBrainPublicKey } from '../utils/brainKeyService';
import { AuthRequest } from './messageController';

/**
 * E2EE key exchange.
 *
 * GET  /api/v1/chat/:chatId/keys  — everything a client needs to encrypt for
 *      this conversation: member public keys, the Brain public key (groups
 *      only), the current key epoch, and the caller's own wrapped group key.
 * POST /api/v1/chat/:chatId/keys  — upload wrapped group-key copies (one per
 *      recipient) for a new epoch. Only participants may post; DMs never get a
 *      'brain' recipient (enforced here — the privacy boundary).
 */

export const getConversationKeys = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const userId = String(req.user._id);

    const convo = await Conversation.findById(chatId).select('users isGroupChat').lean();
    if (!convo) { res.status(404).json({ message: 'Conversation not found' }); return; }
    const isParticipant = (convo.users as any[]).some(u => String(u) === userId);
    if (!isParticipant) { res.status(403).json({ message: 'Not a participant' }); return; }

    const members = await User.find({ _id: { $in: convo.users } })
      .select('publicKey full_name username')
      .lean();

    const latest = await ConversationKey.findOne({ conversationId: chatId })
      .sort({ epoch: -1 })
      .select('epoch')
      .lean();
    const epoch = latest?.epoch || 0;

    const myKey = epoch
      ? await ConversationKey.findOne({ conversationId: chatId, recipientId: userId, epoch })
          .select('encryptedKey epoch')
          .lean()
      : null;

    // Members (and the brain) lacking a wrapped copy at the current epoch —
    // a sender who holds the group key re-wraps for them (late joiners).
    let missingRecipients: string[] = [];
    if (epoch && convo.isGroupChat) {
      const haveKeys = new Set(
        (await ConversationKey.find({ conversationId: chatId, epoch }).select('recipientId').lean())
          .map(r => r.recipientId)
      );
      missingRecipients = members
        .filter(m => m.publicKey && !m.publicKey.startsWith('-----BEGIN') && !haveKeys.has(String(m._id)))
        .map(m => String(m._id));
      if (!haveKeys.has('brain') && getBrainPublicKey()) missingRecipients.push('brain');
    }

    res.status(200).json({
      isGroupChat: !!convo.isGroupChat,
      epoch,
      myWrappedKey: myKey?.encryptedKey || null,
      missingRecipients,
      // PEM keys are the legacy server-generated RSA ones — not usable for nacl.
      members: members.map(m => ({
        id: String(m._id),
        publicKey: m.publicKey && !m.publicKey.startsWith('-----BEGIN') ? m.publicKey : null,
      })),
      brainPublicKey: convo.isGroupChat ? getBrainPublicKey() : null,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const postConversationKeys = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { chatId } = req.params;
    const userId = String(req.user._id);
    const { epoch, keys } = req.body as {
      epoch: number;
      keys: { recipientId: string; encryptedKey: string }[];
    };

    if (!Number.isInteger(epoch) || epoch < 1 || !Array.isArray(keys) || keys.length === 0) {
      res.status(400).json({ message: 'epoch (int ≥1) and non-empty keys[] are required' });
      return;
    }
    if (keys.length > 500 || keys.some(k => !k.recipientId || !k.encryptedKey || k.encryptedKey.length > 2048)) {
      res.status(400).json({ message: 'Invalid keys payload' });
      return;
    }

    const convo = await Conversation.findById(chatId).select('users isGroupChat').lean();
    if (!convo) { res.status(404).json({ message: 'Conversation not found' }); return; }
    const memberIds = new Set((convo.users as any[]).map(u => String(u)));
    if (!memberIds.has(userId)) { res.status(403).json({ message: 'Not a participant' }); return; }

    // Recipients must be conversation members; 'brain' only in group chats.
    for (const k of keys) {
      if (k.recipientId === 'brain') {
        if (!convo.isGroupChat) {
          res.status(400).json({ message: 'DMs are private: no brain key allowed' });
          return;
        }
      } else if (!memberIds.has(k.recipientId)) {
        res.status(400).json({ message: `Recipient ${k.recipientId} is not a participant` });
        return;
      }
    }

    // Idempotent per (conversation, recipient, epoch): a concurrent poster for
    // the same epoch wins on first write, duplicates are ignored.
    const convoObjectId = new (await import('mongoose')).default.Types.ObjectId(String(chatId));
    const ops = keys.map(k => ({
      updateOne: {
        filter: { conversationId: convoObjectId, recipientId: k.recipientId, epoch },
        update: {
          $setOnInsert: {
            conversationId: convoObjectId,
            recipientId: k.recipientId,
            epoch,
            encryptedKey: k.encryptedKey,
            createdBy: req.user._id,
          },
        },
        upsert: true,
      },
    }));
    await ConversationKey.bulkWrite(ops as any[], { ordered: false });

    res.status(201).json({ message: 'Keys stored', epoch });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};
