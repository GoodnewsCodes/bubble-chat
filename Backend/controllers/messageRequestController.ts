import { Request, Response } from 'express';
import { User } from '../models/users';
import { MessageRequest } from '../models/messageRequest';
import { Conversation } from '../models/conversations';
import { Notification } from '../models/notification';
import { sendMessageRequestEmail } from '../utils/mailer';

export interface AuthRequest extends Request {
    user?: any;
}

// ─── Send a Message Request (cross-org) ──────────────────────────────────────
/**
 * POST /api/v1/messages/request/:userId
 * Sends a message request to a user from a different organization.
 */
export const sendMessageRequest = async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized.' }); return; }

    const targetId = req.params.userId as string;
    if (String(req.user._id) === targetId) {
        res.status(400).json({ message: 'You cannot send a message request to yourself.' });
        return;
    }

    try {
        const [sender, target] = await Promise.all([
            User.findById(req.user._id).select('organization full_name'),
            User.findById(targetId).select('organization full_name email privacy_settings'),
        ]);

        if (!target) { res.status(404).json({ message: 'User not found.' }); return; }

        // Same-org users don't need requests
        if (sender?.organization && target?.organization &&
            sender.organization.toLowerCase().trim() === target.organization.toLowerCase().trim()) {
            res.status(400).json({ message: 'Same-organization users can message directly — no request needed.' });
            return;
        }

        // Check for an existing request
        const existing = await MessageRequest.findOne({ from: req.user._id, to: targetId });
        if (existing) {
            res.status(409).json({ message: `A message request is already ${existing.status}.`, request: existing });
            return;
        }

        // Get or create a conversation so we can attach it
        let conv = await Conversation.findOne({
            isGroupChat: false,
            users: { $all: [req.user._id, targetId], $size: 2 },
        });
        if (!conv) {
            conv = await Conversation.create({
                chatName: 'Direct Message',
                isGroupChat: false,
                users: [req.user._id, targetId],
            });
        }

        const request = await MessageRequest.create({
            from: req.user._id,
            to: targetId,
            conversationId: conv._id,
            status: 'pending',
        });

        // Send email only if the target user allows email notifications
        const emailNotifEnabled = target?.privacy_settings?.email_notifications !== false;
        if (target?.email && emailNotifEnabled) {
            sendMessageRequestEmail(target.email, target.full_name || 'User', sender?.full_name || 'A user', sender?.organization || 'Another Organization').catch(err => console.error("Email send error:", err));
        }

        // Add an in-app database notification
        await Notification.create({
            recipient: targetId,
            sender: req.user._id,
            type: 'message_request',
            title: 'New Message Request',
            body: `You received a message request from ${sender?.full_name || 'A user'} at ${sender?.organization || 'an external organization'}.`,
            entityId: request._id.toString(),
            entityType: 'MessageRequest',
        });

        res.status(201).json({ message: 'Message request sent.', request });
    } catch (err: any) {
        res.status(500).json({ message: 'Failed to send message request: ' + err.message });
    }
};

// ─── Respond to a Message Request ─────────────────────────────────────────────
/**
 * PATCH /api/v1/messages/request/:requestId
 * Body: { action: 'accept' | 'decline' }
 */
export const respondToMessageRequest = async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized.' }); return; }

    const { action } = req.body;
    if (!['accept', 'decline'].includes(action)) {
        res.status(400).json({ message: 'action must be "accept" or "decline".' });
        return;
    }

    try {
        const { requestId } = req.params;
        const request = await MessageRequest.findOne({ _id: requestId as string, to: req.user._id });
        if (!request) { res.status(404).json({ message: 'Message request not found.' }); return; }
        if (request.status !== 'pending') {
            res.status(400).json({ message: `Request is already ${request.status}.` });
            return;
        }

        request.status = action === 'accept' ? 'accepted' : 'declined';
        await request.save();

        res.status(200).json({
            message: action === 'accept' ? 'Message request accepted.' : 'Message request declined.',
            request,
        });
    } catch (err: any) {
        res.status(500).json({ message: 'Failed to respond to message request: ' + err.message });
    }
};

// ─── Get Incoming Pending Requests ────────────────────────────────────────────
/**
 * GET /api/v1/messages/requests
 */
export const getMessageRequests = async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized.' }); return; }

    try {
        const requests = await MessageRequest.find({ to: req.user._id, status: 'pending' })
            .populate('from', 'full_name avatar uniqueTag organization org_role isOnline lastSeen')
            .sort({ createdAt: -1 });

        res.status(200).json({ message: 'Pending message requests.', total: requests.length, requests });
    } catch (err: any) {
        res.status(500).json({ message: 'Failed to get message requests: ' + err.message });
    }
};

// ─── Check if Two Users Can Message ───────────────────────────────────────────
/**
 * GET /api/v1/messages/can-message/:userId
 * Returns { canMessage: true } for same-org users or if request is accepted.
 */
export const canMessageUser = async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized.' }); return; }

    const targetId = req.params.userId as string;

    try {
        const [sender, target] = await Promise.all([
            User.findById(req.user._id).select('organization'),
            User.findById(targetId).select('organization'),
        ]);

        if (!target) { res.status(404).json({ message: 'User not found.' }); return; }

        // Same org — always allowed
        const sameOrg = !!(
            sender?.organization &&
            target?.organization &&
            sender.organization.toLowerCase().trim() === target.organization.toLowerCase().trim()
        );

        if (sameOrg) {
            res.status(200).json({ canMessage: true, reason: 'same_org' });
            return;
        }

        // Check for accepted request in either direction
        const accepted = await MessageRequest.findOne({
            $or: [
                { from: req.user._id, to: targetId, status: 'accepted' },
                { from: targetId, to: req.user._id, status: 'accepted' },
            ],
        });

        if (accepted) {
            res.status(200).json({ canMessage: true, reason: 'request_accepted' });
            return;
        }

        // Check if there's already a pending request
        const pending = await MessageRequest.findOne({
            $or: [
                { from: req.user._id, to: targetId, status: 'pending' },
                { from: targetId, to: req.user._id, status: 'pending' },
            ],
        });

        res.status(200).json({
            canMessage: false,
            reason: pending ? 'request_pending' : 'no_request',
            requestStatus: pending?.status || null,
            requestId: pending?._id || null,
            requestDirection: pending
                ? (String(pending.from) === String(req.user._id) ? 'sent' : 'received')
                : null,
        });
    } catch (err: any) {
        res.status(500).json({ message: 'Failed to check messaging permission: ' + err.message });
    }
};
