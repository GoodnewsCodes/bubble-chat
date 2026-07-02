import { Request, Response } from 'express';
import OpenAI from 'openai';
import { Task } from '../models/task';
import { Transaction } from '../models/transaction';
import { Invoice } from '../models/invoice';
import { WorkspaceFile } from '../models/workspaceFile';
import { OrgDocument } from '../models/orgDocument';
import { User } from '../models/users';
import { Conversation } from '../models/conversations';
import { Message } from '../models/messages';
import Post from '../models/post';
import mongoose from 'mongoose';
import { queryVectors, hasPinecone } from '../utils/pinecone';
import { generateEmbedding } from '../utils/embeddings';
import { Organization } from '../models/organizations';
import { decryptForBrain } from '../utils/brainKeyService';

// ─── E2EE-aware message text resolution ──────────────────────────────────────
// Group messages: the Brain is a key recipient and may decrypt via its isolated
// key service. DM messages: the Brain has NO key by design — encrypted DM
// content is dropped (returned as null) so Aida never sees private 1:1 text.
const resolveMessageText = async (
  m: any,
  conversationId: string,
  isGroupChat: boolean
): Promise<string | null> => {
  if (!m?.content) return m?.content ?? null;
  if (!m.is_encrypted) return m.content;
  if (!isGroupChat) return null; // private DM — cryptographically off-limits
  return decryptForBrain(conversationId, m.content);
};

/** Map messages → "Sender: text" lines, silently skipping undecryptable ones. */
const buildTranscriptLines = async (
  messages: any[],
  conversationId: string,
  isGroupChat: boolean,
  senderLabel: (m: any) => string
): Promise<string[]> => {
  const lines: string[] = [];
  for (const m of messages) {
    const text = await resolveMessageText(m, conversationId, isGroupChat);
    if (text) lines.push(`${senderLabel(m)}: ${text}`);
  }
  return lines;
};

// ─── DeepSeek Client (sole AI engine) ────────────────────────────────────────
const deepseekClient = new OpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
});

const hasKey = (): boolean => {
  const key = process.env.DEEPSEEK_API_KEY;
  return !!(key && key.length > 10 && !key.startsWith('your_') && !key.startsWith('add_your_'));
};

// Reject conversational requests loudly if the LLM is unconfigured — better than
// silently returning a templated fallback that hides a misconfigured deploy.
export const requireAidaKey = (_req: Request, res: Response, next: () => void): void => {
  if (!hasKey()) {
    res.status(503).json({ code: 'AIDA_UNCONFIGURED', message: 'Aida is not configured on this deployment.' });
    return;
  }
  next();
};

// ─── Core AI call ─────────────────────────────────────────────────────────────
const callAIDA = async (
  systemPrompt: string,
  userMessage: string,
  maxTokens = 800,
  temp = 0.7
): Promise<string> => {
  if (!hasKey()) return '';
  try {
    const response = await deepseekClient.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature: temp,
    });
    return response.choices[0].message?.content?.trim() || '';
  } catch (err: any) {
    console.error('[DeepSeek] Error calling API:', err?.message || err);
    return '';
  }
};

// ─── Smart local fallback when no AI key ─────────────────────────────────────
const buildSmartFallback = (userName: string, tasks: any[], files: any[], message: string): string => {
  const msg = message.toLowerCase();
  if (msg.includes('schedule a call') || msg.includes('book a meeting') || msg.includes('set up a call')) {
    return `Right away, ${userName}. I've set up a fast-track UI below so you can generate a secure call link directly. [ACTION: {"type":"SCHEDULE_CALL"}]`;
  }

  if (msg.includes('template') || msg.includes('draft')) {
    return `Here is a standard template that you can use, ${userName}: [ACTION: {"type":"CREATE_TEMPLATE", "templateType":"Standard Template", "title":"Standard Organizational Template", "content":"# Standard Template\\n\\n## 1. Overview\\nBrief overview of the topic.\\n\\n## 2. Action Items\\n- [ ] Task 1\\n- [ ] Task 2\\n\\n## 3. Notes\\nAdditional notes go here."}]`;
  }

  if (msg.includes('task') || msg.includes('schedule') || msg.includes('calendar')) {
    if (msg.includes('schedule a task') || msg.includes('add a task')) {
      return `I'll schedule a placeholder task for you right now. [ACTION: {"type":"SCHEDULE_TASK", "title":"Placeholder Task From Aida", "description":"Automatically generated task fallback."}]`;
    }
    if (tasks.length === 0) return `Hi ${userName}! No tasks are scheduled for today. Want me to help you add one? Just say "Schedule a task: [task name] at [time]".`;
    return `Hi ${userName}! You have ${tasks.length} task(s) today: ${tasks.map(t => `"${t.title}"`).join(', ')}. Need help managing any of them?`;
  }

  if (msg.includes('file') || msg.includes('workspace') || msg.includes('document')) {
    if (files.length === 0) return `Your workspace is clean! No files uploaded yet. I can help you organise files once you start uploading.`;
    return `You have ${files.length} file(s) in your workspace. Recent: ${files.slice(0, 3).map((f: any) => `"${f.name}"`).join(', ')}. Want me to find something specific?`;
  }

  if (msg.includes('brief') || msg.includes('today') || msg.includes('summary')) {
    const taskPart = tasks.length > 0 ? `You have ${tasks.length} task(s) today.` : 'No tasks today — a free day!';
    const filePart = files.length > 0 ? ` Your workspace has ${files.length} file(s).` : '';
    return `Good day, ${userName}! ${taskPart}${filePart} I'm Aida, your Bubble assistant. How can I help?`;
  }
  return `Hello ${userName}! I'm Aida, your Bubble intelligence assistant. I can help you with tasks, workspace files, meetings, and more. What would you like to do today?`;
};

// ─── Get or create the Aida bot user ─────────────────────────────────────────
export const getAidaBotUser = async () => {
  let bot = await User.findOne({ is_bot: true, username: 'aida' });
  if (!bot) {
    bot = await User.create({
      full_name: 'Aida',
      username: 'aida',
      email: 'aida@bubble.internal',
      bio: 'Your intelligent workspace companion. Ask me anything about your organization, tasks, meetings, and more.',
      is_bot: true,
      isVerified: true,
      verified_badge: true,
      avatar: '',
      uniqueTag: 'bubble-AIDA-001',
    });
    console.log('[Aida] Bot user created:', bot._id);
  }
  return bot;
};

// ─── RAG: Retrieve relevant org knowledge from MongoDB ───────────────────────
/**
 * This is the core RAG (Retrieval-Augmented Generation) retriever.
 * It searches OrgDocument using MongoDB full-text search on the user's message,
 * then returns actual document content to inject into DeepSeek's context.
 */
const retrieveOrgContext = async (
  message: string,
  userRole: string,
  organizationId: string
): Promise<{ context: string; docsFound: number }> => {
  try {
    // 0. Try Pinecone RAG first if enabled
    if (hasPinecone() && organizationId) {
      try {
        const org = await Organization.findById(organizationId);
        const namespace = org?.pineconeNamespace || `org-${organizationId}`;
        const embedding = await generateEmbedding(message);
        if (embedding.length > 0) {
          const matches = await queryVectors(embedding, 5, organizationId, namespace);
          if (matches && matches.length > 0) {
            const contextText = matches
              .map((match: any) => {
                const chunk = match.metadata?.chunk || '';
                const title = match.metadata?.title || 'Knowledge Piece';
                const dept = match.metadata?.department || 'general';
                return `--- [Brain Match: ${title}] (Dept: ${dept}) ---\n${chunk}`;
              })
              .join('\n\n');
            console.log(`[Aida RAG] Retrieved ${matches.length} matches from Pinecone namespace: ${namespace}`);
            return { context: contextText, docsFound: matches.length };
          }
        }
      } catch (pineconeErr) {
        console.error('[Aida RAG] Pinecone query failed, falling back to DB:', pineconeErr);
      }
    }

    // Determine which access levels this user can see
    const accessFilter: Record<string, any> = { organizationId: organizationId };

    if (userRole !== 'admin') {
      accessFilter.accessLevel = { $in: ['public', 'restricted'] };
    }

    // 1. PRIMARY: MongoDB full-text search (uses the text index on title+content+tags)
    let orgDocs: any[] = [];
    try {
      orgDocs = await OrgDocument.find(
        { $text: { $search: message }, ...accessFilter },
        { score: { $meta: 'textScore' } }
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(5)
        .lean();
    } catch {
      // Text index might not be built yet — fall back to tag search
    }

    // 2. FALLBACK: if text search yields nothing, do a tag/keyword match
    if (orgDocs.length === 0) {
      const keywords = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      orgDocs = await OrgDocument.find({
        ...accessFilter,
        $or: [
          { tags: { $in: keywords } },
          { department: { $in: keywords } },
        ],
      }).limit(5).lean();
    }

    // 3. ALWAYS include "general" public docs as baseline context
    if (orgDocs.length < 2) {
      const generalDocs = await OrgDocument.find({
        ...accessFilter,
        $or: [{ department: 'general' }, { tags: { $in: ['mission', 'values', 'policy'] } }],
      })
        .limit(3)
        .lean();
      // merge without duplicates
      const existingIds = new Set(orgDocs.map((d: any) => String(d._id)));
      for (const d of generalDocs) {
        if (!existingIds.has(String(d._id))) orgDocs.push(d);
      }
    }

    if (orgDocs.length === 0) return { context: '', docsFound: 0 };

    // Format for DeepSeek context window — include actual content (capped per doc)
    const contextText = orgDocs
      .map((doc: any) => {
        const contentSnippet = doc.content?.substring(0, 2000) || 'No content';
        return `--- [DOC: ${doc.title}] (Dept: ${doc.department}, Tags: ${(doc.tags || []).join(', ')}) ---\n${contentSnippet}`;
      })
      .join('\n\n');

    return { context: contextText, docsFound: orgDocs.length };
  } catch (err) {
    console.error('[Aida RAG] Context retrieval error:', err);
    return { context: '', docsFound: 0 };
  }
};

// ─── Build the full system prompt for AIda ─────────────────────────────────
const buildAidaSystemPrompt = (
  userName: string,
  userRole: string,
  userBio: string,
  orgContext: string,
  fileContext: string,
  taskContext: string,
  upcomingContext: string,
  contactsContext: string = '',
  pageContext?: string,
  orgIdentity?: { organization?: string; org_role?: string; org_size?: string; org_industry?: string }
): string => `You are Aida, the intelligent AI assistant of the Bubble organizational platform. You are powered by DeepSeek AI.

CRITICAL TEMPORAL ANCHOR (YOUR SYSTEM CLOCK):
- Today's Exact Date and Time: ${new Date().toString()}
- You must always calculate relativity (like "tomorrow" or "today" or "next week" or "this Tuesday") strictly using this timestamp. Do not hallucinate dates!

IDENTITY OF THE USER YOU ARE HELPING:
- Name: ${userName}
- Platform Role: ${userRole}
${orgIdentity?.org_role ? `- Job Title: ${orgIdentity.org_role}` : ''}
${orgIdentity?.organization ? `- Company: ${orgIdentity.organization}` : ''}
${orgIdentity?.org_industry ? `- Industry: ${orgIdentity.org_industry}` : ''}
${orgIdentity?.org_size ? `- Company Size: ${orgIdentity.org_size} employees` : ''}
- Bio: ${userBio || 'Not provided'}
${pageContext ? `- Currently in: ${pageContext}` : ''}

${orgContext
    ? `COMPANY KNOWLEDGE BASE (retrieved from your organization's documents — use this to give accurate, grounded answers):
${orgContext}
`
    : 'No organizational documents are currently indexed. Admins can add company knowledge docs via Settings > Aida Knowledge Base.\n'
  }
${contactsContext ? `USER CONTACTS (people the user can call or invite to meetings):\n${contactsContext}\n` : ''}
WORKSPACE SNAPSHOT:
${fileContext}
${taskContext}
${upcomingContext}

YOUR CAPABILITIES:
1. Answer questions using the organization's knowledge base above
2. Schedule tasks/meetings/phases to the Calendar
3. Find files in the workspace
4. Create professional templates (meeting agendas, project plans, daily schedules, policy drafts, etc.)
5. Summarize meetings and extract action items
6. Give daily briefings and productivity tips
7. Break down goals into realistic timelines and actionable phases (multi-week plans)
8. Schedule a call or group call with contacts
9. Support escalation — prepare messages to management when users need help
10. Suggest smart message drafts based on recipient's role and org context

INLINE ACTION BLOCKS (embed in your reply only when performing an action):
- Schedule task: [ACTION: {"type":"SCHEDULE_TASK","title":"...","startTime":"YYYY-MM-DDTHH:mm:ss","description":"..."}]
- Find file: [ACTION: {"type":"FIND_FILE","payload":"search keywords"}]
- Open Calendar: [ACTION: {"type":"OPEN_CALENDAR"}]
- Generate Call Link (solo): [ACTION: {"type":"SCHEDULE_CALL","callType":"video"}]
- Group/Contact Call: [ACTION: {"type":"SCHEDULE_GROUP_CALL","title":"...","participants":["Name1","Name2"],"callType":"video|audio"}]
- Plan phases into calendar: [ACTION: {"type":"PLAN_PHASES","planTitle":"...","phases":[{"title":"...","description":"...","startOffsetDays":0,"durationDays":7}]}]
- Create Template: [ACTION: {"type":"CREATE_TEMPLATE","templateType":"meeting_agenda|daily_plan|project_brief|weekly_review|management_request|goal_timeline|goal_breakdown","title":"...","content":"full template text here"}]

RULES:
- Always address the user by their first name
- When org knowledge is available, cite it in your answer ("According to our [doc name]...")
- When scheduling or goal planning, always confirm with a specific date/time and follow up
- Use PLAN_PHASES for multi-week plans; it will create real calendar entries for each phase
- When the user mentions a person's name and wants to call them, use SCHEDULE_GROUP_CALL with that name in participants
- Tailor responses to the user's job title and industry if known
- Be concise, warm, and action-oriented
- Never make up company policies — use only what's in the knowledge base`;

// ─── Get or create Aida DM Conversation for a user ───────────────────────────
export const getAidaConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?._id;
    const bot = await getAidaBotUser();

    let conv = await Conversation.findOne({
      isGroupChat: false,
      users: { $all: [userId, bot._id], $size: 2 },
    }).populate('latestMessage');

    if (!conv) {
      conv = await Conversation.create({
        chatName: 'Aida',
        isGroupChat: false,
        users: [userId, bot._id],
      });
    }

    res.status(200).json({
      conversation: {
        _id: conv._id,
        chatName: 'Aida',
        isGroupChat: false,
        users: conv.users,
        latestMessage: conv.latestMessage,
        isAidaBot: true,
        botId: bot._id,
      },
    });
  } catch (error: any) {
    console.error('[Aida] Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get Aida conversation.' });
  }
};

// ─── Chat with Aida (persisted in Messages collection) ───────────────────────
export const chatWithAidaInConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, conversationId } = req.body;
    const userId = (req.user as any)?._id;

    if (!message) { res.status(400).json({ error: 'message is required' }); return; }

    const bot = await getAidaBotUser();
    const user = await User.findById(userId);
    const userName = user?.full_name || user?.username || 'Voyager';
    const userRole = (user as any)?.role || 'employee';

    // Resolve conversation
    let conv;
    if (conversationId) conv = await Conversation.findById(conversationId);
    if (!conv) {
      conv = await Conversation.findOne({
        isGroupChat: false,
        users: { $all: [userId, bot._id], $size: 2 },
      });
    }
    if (!conv) {
      conv = await Conversation.create({
        chatName: 'Aida',
        isGroupChat: false,
        users: [userId, bot._id],
      });
    }

    // Save user message first
    const userMsg = await Message.create({
      sender: userId,
      content: message,
      chat: conv._id,
      message_type: 'text',
      readBy: [userId],
    });

    // Fetch all context in parallel (including contacts)
    const [recentFiles, todayTasks, upcomingTasks, { context: orgContext }, userContacts] = await Promise.all([
      WorkspaceFile.find({ uploadedBy: userId }).sort({ createdAt: -1 }).limit(5).lean(),
      Task.find({
        $or: [{ user_id: userId }, { assignedTo: userId }],
        start_time: { $gte: new Date(new Date().setHours(0, 0, 0, 0)), $lte: new Date(new Date().setHours(23, 59, 59, 999)) },
        status: { $nin: ['done', 'cancelled'] },
      }).limit(5).lean(),
      Task.find({
        $or: [{ user_id: userId }, { assignedTo: userId }],
        start_time: { $gt: new Date() },
        status: { $nin: ['done', 'cancelled'] },
      }).sort({ start_time: 1 }).limit(3).lean(),
      retrieveOrgContext(message, userRole, (user as any)?.organizationId || ''),
      User.findById(userId).select('contacts').lean().then(async (u: any) => {
        if (!u?.contacts?.length) return [];
        return User.find({ _id: { $in: u.contacts } }).select('full_name username').limit(15).lean();
      }).catch(() => []),
    ]);

    // Conversation history (last 26 messages as memory)
    const history = await Message.find({ chat: conv._id })
      .sort({ createdAt: -1 })
      .limit(26)
      .populate('sender', 'full_name username is_bot')
      .lean();
    const historyText = (await buildTranscriptLines(
      history.reverse(),
      String(conv._id),
      !!(conv as any).isGroupChat,
      (m: any) => (m.sender?.is_bot ? 'Aida' : (m.sender?.full_name || 'User'))
    )).join('\n');

    const fileContext = recentFiles.length > 0
      ? `Workspace files: ${recentFiles.map((f: any) => `${f.name} (${f.fileType})`).join(', ')}.`
      : 'No workspace files yet.';
    const taskContext = todayTasks.length > 0
      ? `Today's tasks: ${todayTasks.map((t: any) => `"${t.title}"`).join(', ')}.`
      : 'No tasks today.';
    const upcomingContext = upcomingTasks.length > 0
      ? `Upcoming: ${upcomingTasks.map((t: any) => `"${t.title}" on ${new Date(t.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`).join(', ')}.`
      : '';
    const contactsContext = (userContacts as any[]).length > 0
      ? (userContacts as any[]).map((c: any) => `- ${c.full_name || c.username}`).join('\n')
      : '';

    const systemPrompt = buildAidaSystemPrompt(
      userName, userRole, user?.bio || '', orgContext, fileContext, taskContext, upcomingContext, contactsContext,
      undefined,
      {
        organization: (user as any)?.organization,
        org_role: (user as any)?.org_role,
        org_size: (user as any)?.org_size,
        org_industry: (user as any)?.org_industry,
      }
    );
    const fullUserMessage = historyText
      ? `Recent conversation:\n${historyText}\n\nUser: ${message}`
      : message;

    const rawReply = await callAIDA(systemPrompt, fullUserMessage, 600, 0.65);
    let reply = rawReply;
    const actionResults: any[] = [];

    // Parse and execute inline action blocks
    const actionMatches = [...(rawReply || '').matchAll(/\[ACTION:\s*(\{.*?\})\s*\]/gis)];
    for (const match of actionMatches) {
      try {
        const actionData = JSON.parse(match[1]);
        reply = reply.replace(match[0], '').trim();

        if (actionData.type === 'FIND_FILE') {
          const keywords = (actionData.payload || '').toLowerCase().split(/\s+/);
          const allFiles = await WorkspaceFile.find({ uploadedBy: userId }).lean();
          const found = allFiles.filter((f: any) => {
            const text = `${f.name} ${f.description || ''} ${(f.tags || []).join(' ')}`.toLowerCase();
            return keywords.some((kw: string) => kw.length > 2 && text.includes(kw));
          }).slice(0, 3);
          actionData.files = found;
          if (found.length > 0) reply += `\n\nI found ${found.length} matching file(s).`;
        }

        if (actionData.type === 'SCHEDULE_TASK') {
          let start = actionData.startTime ? new Date(actionData.startTime) : new Date();
          if (isNaN(start.getTime())) {
            console.warn(`[Aida] Invalid date parsed: ${actionData.startTime}. Fallback to Now+1hr.`);
            start = new Date();
            start.setHours(start.getHours() + 1, 0, 0, 0);
          }
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          await Task.create({
            title: actionData.title,
            description: actionData.description || '',
            user_id: userId,
            start_time: start,
            end_time: end,
            status: 'todo',
            priority: 'medium',
          });
          if (!reply) reply = `Done! I've scheduled "${actionData.title}" for ${start.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}. You can view it on your Calendar.`;
        }

        // SCHEDULE_GROUP_CALL — generates a room link with contact info
        if (actionData.type === 'SCHEDULE_GROUP_CALL') {
          const callType = actionData.callType || 'video';
          const participants = actionData.participants || [];
          actionData.callType = callType;
          actionData.participants = participants;
          if (!reply) {
            const whoText = participants.length > 0 ? ` with ${participants.join(', ')}` : '';
            reply = `Ready! I've set up a ${callType} call link${whoText}. Use the card below to join or copy the link to share.`;
          }
        }

        // PLAN_PHASES — create sequential tasks for each phase
        if (actionData.type === 'PLAN_PHASES') {
          const phases: any[] = actionData.phases || [];
          const createdTasks: any[] = [];
          const now = new Date();
          for (const phase of phases) {
            const start = new Date(now);
            start.setDate(start.getDate() + (phase.startOffsetDays || 0));
            start.setHours(9, 0, 0, 0);
            const end = new Date(start);
            end.setDate(end.getDate() + (phase.durationDays || 7));
            const task = await Task.create({
              title: phase.title,
              description: `[${actionData.planTitle}] ${phase.description || ''}`.trim(),
              user_id: userId,
              start_time: start,
              end_time: end,
              status: 'todo',
              priority: 'medium',
            });
            createdTasks.push(task);
          }
          actionData.createdTasks = createdTasks;
          if (!reply) {
            reply = `I've broken "${actionData.planTitle}" into ${phases.length} phase(s) and added them all to your Calendar. Check the plan card below!`;
          } else {
            reply += `\n\nAll ${phases.length} phases added to your Calendar.`;
          }
        }

        if (actionData.type === 'CREATE_TEMPLATE') {
          if (!reply) reply = `Here's your **${actionData.title || actionData.templateType}** template, ${userName.split(' ')[0]}!`;
          reply += `\n\n\`\`\`\n${actionData.content}\n\`\`\``;
          actionData.templateContent = actionData.content;
        }

        actionResults.push(actionData);
      } catch { /* ignore malformed actions */ }
    }

    if (!reply) reply = buildSmartFallback(userName, todayTasks, recentFiles, message);

    // Save Aida's reply as a message
    const botMsg = await Message.create({
      sender: bot._id,
      content: reply,
      chat: conv._id,
      message_type: 'text',
      readBy: [bot._id],
    });

    await Conversation.findByIdAndUpdate(conv._id, { latestMessage: botMsg._id });

    res.status(200).json({
      reply,
      actions: actionResults,
      userMessage: userMsg,
      botMessage: botMsg,
      conversationId: conv._id,
      usedOrgContext: !!orgContext,
    });
  } catch (error: any) {
    console.error('[Aida] Chat in conversation error:', error);
    res.status(500).json({ error: 'Failed to chat with Aida.' });
  }
};

// ─── Summarize a conversation ─────────────────────────────────────────────────
export const summarizeConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = (req.user as any)?._id;

    const conv = await Conversation.findOne({ _id: id, users: userId });
    if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return; }

    const messages = await Message.find({ chat: id })
      .sort({ createdAt: -1 })
      .limit(30)
      .populate('sender', 'full_name username is_bot')
      .lean();

    if (messages.length === 0) {
      res.status(200).json({ summary: 'No messages in this conversation yet.' });
      return;
    }

    const transcriptLines = await buildTranscriptLines(
      messages.reverse(),
      String(id),
      !!(conv as any).isGroupChat,
      (m: any) => (m.sender?.is_bot ? 'Aida' : (m.sender?.full_name || m.sender?.username || 'User'))
    );
    if (transcriptLines.length === 0) {
      // Every message was E2EE and outside the Brain's reach (private DM).
      res.status(200).json({
        summary: 'This conversation is end-to-end encrypted and private — Aida cannot read or summarize it.',
        messageCount: messages.length,
        encrypted: true,
      });
      return;
    }
    const transcript = transcriptLines.join('\n');

    let summary = '';
    if (hasKey()) {
      summary = await callAIDA(
        'You are a meeting assistant. Summarize conversations concisely.',
        `Summarize this conversation in 2–4 bullet points. Focus on decisions, action items, and key info.\n\nConversation:\n${transcript.substring(0, 3000)}\n\nSummary:`,
        200,
        0.5
      );
    }

    if (!summary) {
      const lastLine = transcriptLines[transcriptLines.length - 1] || '';
      summary = `Conversation with ${messages.length} message(s). Latest: "${lastLine.substring(0, 100)}..."`;
    }

    res.status(200).json({ summary, messageCount: messages.length });
  } catch (error: any) {
    console.error('[Aida] Summarize error:', error);
    res.status(500).json({ error: 'Failed to summarize conversation.' });
  }
};

// ─── Schedule a task from Aida ────────────────────────────────────────────────
export const aidaScheduleTask = async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, startTime, description } = req.body;
    const userId = (req.user as any)?._id;
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }

    const start = startTime ? new Date(startTime) : (() => {
      const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return d;
    })();
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    const task = await Task.create({
      title,
      description: description || '',
      user_id: userId,
      start_time: start,
      end_time: end,
      status: 'todo',
      priority: 'medium',
    });

    res.status(201).json({
      message: 'Task scheduled by Aida.',
      task,
      reply: `Done! I've scheduled "${title}" for ${start.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}. You can view it on your Calendar.`,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to schedule task.' });
  }
};

/**
 * POST /api/v1/aida/chat
 * Main AidaPage conversational endpoint
 */
export const chatWithAida = async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, context } = req.body;
    const userId = (req.user as any)?._id;
    if (!message) { res.status(400).json({ error: 'Message is required' }); return; }

    const user = await User.findById(userId);
    const userName = user?.full_name || user?.username || 'Voyager';
    const userRole = (user as any)?.role || 'employee';

    const [recentFiles, todayTasks, upcomingTasks, { context: orgContext }, userContacts] = await Promise.all([
      WorkspaceFile.find({ uploadedBy: userId }).sort({ createdAt: -1 }).limit(5).lean(),
      Task.find({
        $or: [{ user_id: userId }, { assignedTo: userId }],
        start_time: { $gte: new Date(new Date().setHours(0, 0, 0, 0)), $lte: new Date(new Date().setHours(23, 59, 59, 999)) },
        status: { $nin: ['done', 'cancelled'] },
      }).limit(5).lean(),
      Task.find({
        $or: [{ user_id: userId }, { assignedTo: userId }],
        start_time: { $gt: new Date() },
        status: { $nin: ['done', 'cancelled'] },
      }).sort({ start_time: 1 }).limit(3).lean(),
      retrieveOrgContext(message, userRole, (user as any)?.organizationId || ''),
      User.findById(userId).select('contacts').lean().then(async (u: any) => {
        if (!u?.contacts?.length) return [];
        return User.find({ _id: { $in: u.contacts } }).select('full_name username').limit(15).lean();
      }).catch(() => []),
    ]);

    const fileContext = recentFiles.length > 0
      ? `Recent workspace files: ${recentFiles.map((f: any) => `${f.name} (${f.fileType})`).join(', ')}.`
      : 'Workspace is empty.';
    const taskContext = todayTasks.length > 0
      ? `Today's pending tasks: ${todayTasks.map((t: any) => `"${t.title}" at ${new Date(t.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`).join(', ')}.`
      : 'No tasks today.';
    const upcomingContext = upcomingTasks.length > 0
      ? `Upcoming: ${upcomingTasks.map((t: any) => `"${t.title}" on ${new Date(t.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`).join(', ')}.`
      : '';
    const contactsContext = (userContacts as any[]).length > 0
      ? (userContacts as any[]).map((c: any) => `- ${c.full_name || c.username}`).join('\n')
      : '';

    const systemPrompt = buildAidaSystemPrompt(
      userName, userRole, user?.bio || '', orgContext, fileContext, taskContext, upcomingContext, contactsContext,
      context ? `${context} section` : undefined,
      {
        organization: (user as any)?.organization,
        org_role: (user as any)?.org_role,
        org_size: (user as any)?.org_size,
        org_industry: (user as any)?.org_industry,
      }
    );

    let finalMessage = message;
    if (req.body.history && Array.isArray(req.body.history) && req.body.history.length > 0) {
      const historyStr = req.body.history.map((m: any) => `${m.role === 'user' ? 'User' : 'Aida'}: ${m.content}`).join('\n\n');
      finalMessage = `### Recent Conversation History ###\n${historyStr}\n\n### Current Input ###\nUser: ${message}`;
    }

    const rawReply = await callAIDA(systemPrompt, finalMessage, 600, 0.65);
    let reply = rawReply;
    const actionResults: any[] = [];

    const actionMatches = [...(rawReply || '').matchAll(/\[ACTION:\s*(\{.*?\})\s*\]/gis)];
    for (const match of actionMatches) {
      try {
        const actionData = JSON.parse(match[1]);
        reply = reply.replace(match[0], '').trim();

        if (actionData.type === 'FIND_FILE') {
          const keywords = (actionData.payload || '').toLowerCase().split(/\s+/);
          const allFiles = await WorkspaceFile.find({ uploadedBy: userId }).lean();
          const found = allFiles.filter((f: any) => {
            const text = `${f.name} ${f.description || ''} ${(f.tags || []).join(' ')}`.toLowerCase();
            return keywords.some((kw: string) => kw.length > 2 && text.includes(kw));
          }).slice(0, 3);
          actionData.files = found;
          if (found.length > 0) reply += `\n\nI found ${found.length} matching file(s).`;
        }

        if (actionData.type === 'SCHEDULE_TASK') {
          const start = actionData.startTime ? new Date(actionData.startTime) : (() => {
            const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return d;
          })();
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          await Task.create({
            title: actionData.title,
            description: actionData.description || '',
            user_id: userId,
            start_time: start,
            end_time: end,
            status: 'todo',
            priority: 'medium',
          });
          if (!reply) reply = `Done! I've scheduled "${actionData.title}" for ${start.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}. You can view it on your Calendar.`;
        }

        if (actionData.type === 'SCHEDULE_GROUP_CALL') {
          const callType = actionData.callType || 'video';
          const participants = actionData.participants || [];
          actionData.callType = callType;
          actionData.participants = participants;
          if (!reply) {
            const whoText = participants.length > 0 ? ` with ${participants.join(', ')}` : '';
            reply = `Ready! I've set up a ${callType} call link${whoText}. Use the card below to join or copy the link to share.`;
          }
        }

        if (actionData.type === 'PLAN_PHASES') {
          const phases: any[] = actionData.phases || [];
          const createdTasks: any[] = [];
          const now = new Date();
          for (const phase of phases) {
            const start = new Date(now);
            start.setDate(start.getDate() + (phase.startOffsetDays || 0));
            start.setHours(9, 0, 0, 0);
            const end = new Date(start);
            end.setDate(end.getDate() + (phase.durationDays || 7));
            const task = await Task.create({
              title: phase.title,
              description: `[${actionData.planTitle}] ${phase.description || ''}`.trim(),
              user_id: userId,
              start_time: start,
              end_time: end,
              status: 'todo',
              priority: 'medium',
            });
            createdTasks.push(task);
          }
          actionData.createdTasks = createdTasks;
          if (!reply) {
            reply = `I've broken "${actionData.planTitle}" into ${phases.length} phase(s) and added them all to your Calendar!`;
          } else {
            reply += `\n\nAll ${phases.length} phases added to your Calendar.`;
          }
        }

        if (actionData.type === 'CREATE_TEMPLATE') {
          if (!reply) reply = `Here's your **${actionData.title || actionData.templateType}** template, ${userName.split(' ')[0]}!`;
          actionData.templateContent = actionData.content;
        }

        actionResults.push(actionData);
      } catch (e) {
        console.error('Failed to parse Aida action', e);
      }
    }

    if (!reply) reply = buildSmartFallback(userName, todayTasks, recentFiles, message);

    res.status(200).json({ reply, actions: actionResults, usedOrgContext: !!orgContext });
  } catch (error: any) {
    console.error('Aida Chat Error:', error);
    res.status(500).json({ error: 'Error processing your request with Aida.' });
  }
};

/**
 * GET /api/v1/aida/daily-briefing
 */
export const getDailyBriefing = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)._id;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);

    const [todayTasks, upcomingMeetings, user] = await Promise.all([
      Task.find({ $or: [{ user_id: userId }, { assignedTo: userId }], start_time: { $gte: start, $lte: end } }).lean(),
      (async () => {
        try {
          const Meeting = (await import('../models/meeting')).Meeting;
          return Meeting.find({ $or: [{ host: userId }, { attendees: userId }], startedAt: { $gte: start, $lte: end } }).lean();
        } catch { return []; }
      })(),
      User.findById(userId),
    ]);

    const userName = user?.full_name || user?.username || 'there';
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const localBriefing = [
      `${greeting}, ${userName}!`,
      todayTasks.length > 0 ? `You have ${todayTasks.length} task(s) scheduled today.` : 'Your schedule is clear today.',
      upcomingMeetings.length > 0 ? `${upcomingMeetings.length} meeting(s) on your calendar.` : '',
    ].filter(Boolean).join(' ');

    if (hasKey() && todayTasks.length > 0) {
      const taskLines = todayTasks.map((t: any) => `- ${t.title} at ${new Date(t.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`).join('\n');
      const aiReply = await callAIDA(
        `You are Aida, the AI assistant. Write warm, motivating briefings.`,
        `Write a warm 2-sentence morning briefing for ${userName}. Keep it motivating.\nTasks today:\n${taskLines}`,
        150, 0.6
      );
      if (aiReply) {
        res.status(200).json({ reply: aiReply, tasks: todayTasks, meetings: upcomingMeetings });
        return;
      }
    }

    res.status(200).json({ reply: localBriefing, tasks: todayTasks, meetings: upcomingMeetings });
  } catch (error: any) {
    console.error('Aida Briefing Error:', error);
    res.status(500).json({ error: 'Error getting daily briefing.' });
  }
};

/**
 * GET /api/v1/aida/financial-advice
 */
export const getFinancialAdvice = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)._id;
    const [recentTransactions, overdueInvoices] = await Promise.all([
      Transaction.find({ user_id: userId }).sort({ createdAt: -1 }).limit(10).lean(),
      Invoice.find({ user_id: userId, status: 'overdue' }).lean(),
    ]);

    const tStrings = recentTransactions.map((t: any) => `${t.type}: $${(t.amount / 100).toFixed(2)} ${t.currency}`).join('\n') || 'No recent transactions.';
    const expenses = recentTransactions.filter((t: any) => t.type === 'expense' || t.type === 'withdrawal');
    const totalSpent = expenses.reduce((s, t) => s + t.amount, 0) / 100;
    const localReply = overdueInvoices.length > 0
      ? `You have ${overdueInvoices.length} overdue invoice(s) requiring immediate attention. Total recent spend: $${totalSpent.toFixed(2)}.`
      : recentTransactions.length > 0
        ? `Recent activity: ${tStrings.split('\n').slice(0, 3).join('; ')}. Total recent spend: $${totalSpent.toFixed(2)}.`
        : 'No recent financial activity found.';

    if (hasKey() && recentTransactions.length > 0) {
      const invoiceWarning = overdueInvoices.length > 0 ? `\nOVERDUE: ${overdueInvoices.length} invoice(s) past due.` : '';
      const aiReply = await callAIDA(
        'You are Aida, an AI financial advisor assistant.',
        `Give one short, helpful financial tip based on these transactions:\n${tStrings}${invoiceWarning}`,
        150, 0.5
      );
      if (aiReply) { res.status(200).json({ reply: aiReply, overdueInvoices }); return; }
    }

    res.status(200).json({ reply: localReply, overdueInvoices });
  } catch (error: any) {
    res.status(500).json({ error: 'Error getting financial advice.' });
  }
};

/**
 * POST /api/v1/aida/extract-action-items
 */
export const extractActionItems = async (req: Request, res: Response): Promise<void> => {
  try {
    const { transcript, attendeeNames = [] } = req.body;
    if (!transcript) { res.status(400).json({ error: 'transcript is required' }); return; }

    if (!hasKey()) {
      // Local fallback extraction
      const lines = transcript.split(/[.\n]/);
      const actionItems: any[] = [];
      const actionPatterns = /\b(will|should|must|needs? to|action:|todo:|task:)\b/i;
      lines.forEach((line: string) => {
        const trimmed = line.trim();
        if (trimmed.length > 10 && actionPatterns.test(trimmed)) {
          const assignedTo = attendeeNames.find((n: string) => trimmed.toLowerCase().includes(n.toLowerCase())) || null;
          actionItems.push({ text: trimmed, assignedToName: assignedTo, deadline: null });
        }
      });
      res.status(200).json({ actionItems: actionItems.slice(0, 10), warning: 'Local extraction — DeepSeek API key needed for full AI extraction.' });
      return;
    }

    const attendeeLine = attendeeNames.length > 0 ? `Attendees: ${attendeeNames.join(', ')}.` : '';
    const raw = await callAIDA(
      'You are an expert meeting analyst. Extract structured action items from transcripts. Return ONLY valid JSON.',
      `Extract action items from this transcript. ${attendeeLine}\n\nTRANSCRIPT:\n${transcript.substring(0, 3000)}\n\nReturn ONLY this JSON: {"actionItems": [{"text": "...", "assignedToName": "...or null", "deadline": "...or null"}]}`,
      600, 0.3
    );

    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        res.status(200).json(parsed); return;
      } catch { /* fall through */ }
    }

    res.status(200).json({ actionItems: [], warning: 'Could not parse AI response.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to extract action items.' });
  }
};

/**
 * POST /api/v1/aida/search-workspace
 */
export const searchWorkspace = async (req: Request, res: Response): Promise<void> => {
  try {
    const { query } = req.body;
    const userId = (req.user as any)?._id;
    if (!query) { res.status(400).json({ error: 'query is required' }); return; }

    const files = await WorkspaceFile.find({ uploadedBy: userId }).select('name fileType source description tags createdAt').lean();
    if (files.length === 0) { res.status(200).json({ files: [], message: 'Your workspace is empty.' }); return; }

    const keywords = query.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
    const scored = files.map((f: any) => {
      const text = `${f.name} ${f.description || ''} ${(f.tags || []).join(' ')}`.toLowerCase();
      const score = keywords.reduce((s: number, kw: string) => s + (text.includes(kw) ? 1 : 0), 0);
      return { ...f, score };
    }).filter((f: any) => f.score > 0).sort((a: any, b: any) => b.score - a.score);

    let aiSummary = '';
    if (hasKey() && scored.length > 0) {
      const fileList = scored.slice(0, 10).map((f: any) => `- ${f.name} (${f.fileType})`).join('\n');
      aiSummary = await callAIDA(
        'You are Aida, a workspace assistant.',
        `User searched "${query}". Matching files:\n${fileList}\nWhich is most relevant and why? (one sentence)`,
        100, 0.5
      );
    }

    res.status(200).json({ files: scored.slice(0, 10), aiSummary });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to search workspace.' });
  }
};

/**
 * POST /api/v1/aida/schedule-suggestion
 */
export const scheduleSuggestion = async (req: Request, res: Response): Promise<void> => {
  try {
    const { duration = 30 } = req.body;
    const userId = (req.user as any)?._id;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const endWindow = new Date(tomorrow);
    endWindow.setDate(endWindow.getDate() + 7);

    const existingTasks = await Task.find({
      $or: [{ user_id: userId }, { assignedTo: userId }],
      start_time: { $gte: tomorrow, $lte: endWindow },
      status: { $nin: ['done', 'cancelled'] },
    }).sort({ start_time: 1 }).lean();

    const suggestions: { date: string; time: string; label: string }[] = [];
    const cursor = new Date(tomorrow);
    cursor.setHours(9, 0, 0, 0);

    while (cursor <= endWindow && suggestions.length < 5) {
      const slotEnd = new Date(cursor.getTime() + duration * 60 * 1000);
      const conflict = existingTasks.some((t: any) => {
        const tStart = new Date(t.start_time);
        const tEnd = new Date(t.end_time);
        return cursor < tEnd && slotEnd > tStart;
      });
      if (!conflict && cursor.getHours() < 18) {
        suggestions.push({
          date: cursor.toISOString().split('T')[0],
          time: cursor.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
          label: `${cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${cursor.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`,
        });
      }
      cursor.setMinutes(cursor.getMinutes() + 30);
      if (cursor.getHours() >= 18) { cursor.setDate(cursor.getDate() + 1); cursor.setHours(9, 0, 0, 0); }
    }

    res.status(200).json({ suggestions, message: `Found ${suggestions.length} open slot(s) for a ${duration}-min session.` });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate schedule suggestion.' });
  }
};

/**
 * POST /api/v1/aida/summarize-feed
 */
export const summarizeFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const posts = await Post.find({ createdAt: { $gte: today } })
      .sort({ createdAt: -1 }).limit(20)
      .populate('author', 'full_name username').lean();

    if (posts.length === 0) { res.status(200).json({ summary: "Nothing new in your Feed today — it's quiet!" }); return; }

    const postLines = posts.map((p: any) => `- ${p.author?.full_name || 'Someone'}: "${p.content?.substring(0, 80)}"`).join('\n');

    if (hasKey()) {
      const summary = await callAIDA(
        'You are Aida. Summarize organizational feed activity concisely.',
        `Summarize today's social feed in 2 sentences:\n${postLines}`,
        150, 0.6
      );
      if (summary) { res.status(200).json({ summary, postCount: posts.length }); return; }
    }

    res.status(200).json({
      summary: `${posts.length} post(s) in your Feed today. Latest from: ${posts.slice(0, 3).map((p: any) => p.author?.username || 'someone').join(', ')}.`,
      postCount: posts.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to summarize feed.' });
  }
};

/**
 * GET /api/v1/aida/flag-payments
 */
export const flagPayments = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?._id;
    const [transactions, overdueInvoices, unpaidInvoices] = await Promise.all([
      Transaction.find({ user_id: userId }).sort({ createdAt: -1 }).limit(30).lean(),
      Invoice.find({ user_id: userId, status: 'overdue' }).lean(),
      Invoice.find({ user_id: userId, status: 'sent', dueDate: { $lte: new Date() } }).lean(),
    ]);

    const flags: { severity: 'info' | 'warning' | 'critical'; message: string }[] = [];
    if (overdueInvoices.length > 0) flags.push({ severity: 'critical', message: `${overdueInvoices.length} invoice(s) are overdue.` });
    if (unpaidInvoices.length > 0) flags.push({ severity: 'warning', message: `${unpaidInvoices.length} sent invoice(s) have passed their due date.` });

    if (transactions.length >= 3) {
      const expenses = transactions.filter((t: any) => t.type === 'expense' || t.type === 'withdrawal');
      const avg = expenses.reduce((s, t) => s + t.amount, 0) / (expenses.length || 1);
      const unusual = expenses.filter(t => t.amount > avg * 10);
      if (unusual.length > 0) flags.push({ severity: 'warning', message: `Unusual expense detected: ${unusual.map(t => `$${(t.amount / 100).toFixed(2)}`).join(', ')} — significantly above your average.` });
    }

    if (flags.length === 0) flags.push({ severity: 'info', message: 'All finances look healthy — no flags detected.' });

    res.status(200).json({ flags, overdueInvoices, unpaidInvoices });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to analyze payments.' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ORG DOCS CRUD (RAG Knowledge Base Management) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/aida/org-docs
 * List all org knowledge documents (with optional search & filter)
 */
export const listOrgDocs = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?._id;
    const user = await User.findById(userId);
    const userRole = (user as any)?.role || 'employee';

    const { q, department, accessLevel, page = '1', limit = '20' } = req.query as Record<string, string>;

    const accessFilter = userRole === 'admin'
      ? {}
      : { accessLevel: { $in: ['public', 'restricted'] } };

    let query: Record<string, any> = { ...accessFilter };
    if (department) query.department = department.toLowerCase();
    if (userRole === 'admin' && accessLevel) query.accessLevel = accessLevel;

    let docs;
    if (q) {
      try {
        docs = await OrgDocument.find(
          { $text: { $search: q }, ...query },
          { score: { $meta: 'textScore' } }
        )
          .sort({ score: { $meta: 'textScore' } })
          .skip((parseInt(page) - 1) * parseInt(limit))
          .limit(parseInt(limit))
          .select('-content') // don't return full content in list — too heavy
          .lean();
      } catch {
        docs = await OrgDocument.find(query)
          .sort({ createdAt: -1 })
          .skip((parseInt(page) - 1) * parseInt(limit))
          .limit(parseInt(limit))
          .select('-content')
          .lean();
      }
    } else {
      docs = await OrgDocument.find(query)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .select('-content')
        .lean();
    }

    const total = await OrgDocument.countDocuments(query);
    res.status(200).json({ docs, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error: any) {
    console.error('[OrgDocs] List error:', error);
    res.status(500).json({ error: 'Failed to fetch org documents.' });
  }
};

/**
 * GET /api/v1/aida/org-docs/:id
 * Get a single org document with full content
 */
export const getOrgDoc = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?._id;
    const user = await User.findById(userId);
    const userRole = (user as any)?.role || 'employee';

    const accessFilter = userRole === 'admin'
      ? {}
      : { accessLevel: { $in: ['public', 'restricted'] } };

    const doc = await OrgDocument.findOne({ _id: req.params.id, ...accessFilter }).lean();
    if (!doc) { res.status(404).json({ error: 'Document not found or access denied.' }); return; }

    res.status(200).json({ doc });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch org document.' });
  }
};

/**
 * POST /api/v1/aida/org-docs
 * Create a new org knowledge document (admin or manager)
 */
export const createOrgDoc = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?._id;
    const { title, content, department, accessLevel, tags } = req.body;

    if (!title || !content) {
      res.status(400).json({ error: 'title and content are required.' });
      return;
    }

    const doc = await OrgDocument.create({
      title: title.trim(),
      content: content.trim(),
      department: department?.toLowerCase() || 'general',
      accessLevel: accessLevel || 'public',
      tags: Array.isArray(tags) ? tags.map((t: string) => t.toLowerCase().trim()) : [],
      createdBy: userId,
    });

    console.log(`[OrgDocs] New doc created: "${doc.title}" (dept: ${doc.department}, access: ${doc.accessLevel})`);

    // Embed the document into the vector brain so it's retrievable via RAG, not
    // just Mongo full-text. Resolve the creator's org and fire the brain event.
    try {
      const { resolveUserOrg } = await import('../utils/orgResolver');
      const creator = await User.findById(userId);
      const org = creator ? await resolveUserOrg(creator) : null;
      if (org) {
        const { brainEventBus } = await import('../utils/brainEventListener');
        brainEventBus.emit('document_uploaded', {
          documentId: doc._id.toString(),
          organizationId: org._id.toString(),
          uploadedBy: String(userId),
          title: doc.title,
          content: doc.content,
          tags: doc.tags,
          department: doc.department,
        });
      }
    } catch (emitErr) {
      console.error('[OrgDocs] document_uploaded emit failed:', emitErr);
    }

    res.status(201).json({ doc, message: `Org document "${doc.title}" added to AIda's knowledge base.` });
  } catch (error: any) {
    console.error('[OrgDocs] Create error:', error);
    res.status(500).json({ error: 'Failed to create org document.' });
  }
};

/**
 * PATCH /api/v1/aida/org-docs/:id
 * Update an existing org document
 */
export const updateOrgDoc = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?._id;
    const { title, content, department, accessLevel, tags } = req.body;

    const doc = await OrgDocument.findOneAndUpdate(
      { _id: req.params.id, createdBy: userId },
      {
        ...(title && { title: title.trim() }),
        ...(content && { content: content.trim() }),
        ...(department && { department: department.toLowerCase() }),
        ...(accessLevel && { accessLevel }),
        ...(tags && { tags: tags.map((t: string) => t.toLowerCase().trim()) }),
      },
      { returnDocument: 'after' }
    );

    if (!doc) { res.status(404).json({ error: 'Document not found or not yours to edit.' }); return; }
    res.status(200).json({ doc, message: 'Document updated.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update org document.' });
  }
};

/**
 * DELETE /api/v1/aida/org-docs/:id
 * Delete an org document (admin or creator)
 */
export const deleteOrgDoc = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?._id;
    const user = await User.findById(userId);
    const userRole = (user as any)?.role || 'employee';

    const filter = userRole === 'admin'
      ? { _id: req.params.id }
      : { _id: req.params.id, createdBy: userId };

    const doc = await OrgDocument.findOneAndDelete(filter);
    if (!doc) { res.status(404).json({ error: 'Document not found or access denied.' }); return; }

    res.status(200).json({ message: `Document "${doc.title}" deleted from AIda's knowledge base.` });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete org document.' });
  }
};

// ─── Conversation Context: Summary + Suggested Replies ───────────────────────
/**
 * GET /api/v1/aida/conversation-context/:conversationId
 * Returns a short summary of the conversation and 3 AI-suggested replies
 * tailored to the recipient's organizational role and industry.
 */
export const getConversationContext = async (req: Request, res: Response): Promise<void> => {
  try {
    const { conversationId } = req.params;
    const userId = (req.user as any)?._id;

    // Verify this user is in the conversation
    const conv = await Conversation.findOne({ _id: conversationId, users: userId });
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    // Get caller + recipient profiles for context
    const caller = await User.findById(userId).select('full_name organization org_role org_industry').lean();
    const recipientId = (conv as any).users?.find((u: any) => String(u) !== String(userId));
    const recipient = recipientId
      ? await User.findById(recipientId).select('full_name organization org_role org_industry').lean()
      : null;

    // Fetch last 30 messages for summarization
    const messages = await Message.find({ chat: conversationId })
      .sort({ createdAt: -1 })
      .limit(30)
      .populate('sender', 'full_name username is_bot')
      .lean();

    if (messages.length === 0) {
      res.status(200).json({
        summary: null,
        suggestions: [
          'Hi! I wanted to reach out.',
          'Hope you\'re having a great day!',
          'Do you have a moment to connect?',
        ],
        messageCount: 0,
      });
      return;
    }

    const resolvedForContext = await Promise.all(
      messages.reverse().map(async (m: any) => ({
        m,
        text: (await resolveMessageText(m, String(conversationId), !!(conv as any).isGroupChat)) || (m.content ? null : '[media]'),
      }))
    );
    const transcript = resolvedForContext
      .filter(r => r.text !== null)
      .map(({ m, text }: any) => {
        const name = m.sender?.is_bot ? 'Aida' : (m.sender?.full_name || 'User');
        return `${name}: ${text}`;
      })
      .join('\n');

    // If a colleague routed a question here (brain "route to an expert" flow) and
    // it's awaiting THIS user's answer, switch from short replies to drafting one
    // complete answer they can confirm/edit — even if unsure — and widen recall so
    // the facts they need are more likely to surface.
    const routedQuestion = messages.find(
      (m: any) => m.brainQuestionRef && String(m.sender?._id || m.sender) !== String(userId)
    );
    const isRoutedQuestion = !!routedQuestion;
    const recallK = isRoutedQuestion ? 8 : 6;
    const recallThreshold = isRoutedQuestion ? 0.5 : 0.55;

    const callerName = (caller as any)?.full_name || 'User';
    const callerRole = (caller as any)?.org_role || '';
    const callerOrg = (caller as any)?.organization || '';
    const recipientName = (recipient as any)?.full_name || 'them';
    const recipientRole = (recipient as any)?.org_role || '';
    const recipientOrg = (recipient as any)?.organization || '';

    const contextNote = [
      callerRole && `You are ${callerRole}${callerOrg ? ` at ${callerOrg}` : ''}.`,
      recipientRole && `You are messaging ${recipientName}${recipientRole ? `, ${recipientRole}` : ''}${recipientOrg ? ` at ${recipientOrg}` : ''}.`,
    ].filter(Boolean).join(' ');

    let summary = '';
    let suggestions: string[] = [];

    // Ground reply suggestions in the org brain — surfaces facts the user might
    // not remember, mirroring the writing-suggestions retrieval pattern.
    let brainKnowledge = '';
    try {
      const { resolveUserOrg } = await import('../utils/orgResolver');
      const callerUser = await User.findById(userId);
      const org = callerUser ? await resolveUserOrg(callerUser) : null;
      if (org && hasPinecone()) {
        const seed = transcript.slice(-1500);
        const embedding = await generateEmbedding(seed);
        if (embedding.length > 0) {
          const namespace = org.pineconeNamespace || `org-${org._id}`;
          // Pull richer recall so cross-chat/meeting facts the user may have missed
          // surface in the summary + reply suggestions (wider for routed questions).
          const matches = await queryVectors(embedding, recallK, org._id.toString(), namespace);
          brainKnowledge = matches
            .filter((m: any) => m.score >= recallThreshold)
            .map((m: any) => `• ${m.metadata?.chunk || ''}`)
            .join('\n');
        }
      }
    } catch (brainErr) {
      console.error('[Conversation Context] brain seed failed:', brainErr);
    }

    if (hasKey()) {
      const suggestSystemPrompt = isRoutedQuestion
        ? `You are Aida helping ${callerName}${callerRole ? ` (${callerRole})` : ''} answer a question a colleague routed to them because they're the most likely to know it. ${contextNote} Lean on the brain-knowledge facts where relevant. Return ONLY a JSON array of exactly 3 strings: the FIRST is a complete, confident, ready-to-send answer (2-4 sentences) they can lightly edit even if unsure; the SECOND and THIRD are short alternative replies under 15 words. No markdown, no explanation.`
        : `You are Aida, a professional workspace AI. Generate 3 short, contextually-appropriate reply suggestions for ${callerName}${callerRole ? ` (${callerRole})` : ''} to send next. ${contextNote} If the brain-knowledge block contains a fact relevant to the conversation, use it — these are facts the user may not know off the top of their head. Keep each suggestion under 15 words. Return ONLY a JSON array of 3 strings, no markdown, no explanation.`;

      const suggestUserPrompt = [
        isRoutedQuestion && routedQuestion?.content ? `Question to answer:\n${routedQuestion.content}` : '',
        `Conversation:\n${transcript.substring(0, 2000)}`,
        brainKnowledge ? `Brain knowledge from this organization (use any relevant fact):\n${brainKnowledge}` : '',
        isRoutedQuestion ? 'Draft the answer + 2 short alternates as a JSON array:' : 'Generate 3 reply suggestions as a JSON array:',
      ].filter(Boolean).join('\n\n');

      const [summaryRes, suggestRes] = await Promise.all([
        callAIDA(
          'You are Aida, a professional workspace AI. Summarize conversations in 1-2 concise sentences, focusing on key decisions and pending items.',
          `${contextNote}\n\nConversation (last ${messages.length} messages):\n${transcript.substring(0, 2500)}\n\nSummarize this conversation in 1-2 sentences:`,
          120,
          0.4
        ),
        callAIDA(
          suggestSystemPrompt,
          suggestUserPrompt,
          isRoutedQuestion ? 400 : 200,
          0.7
        ),
      ]);

      summary = summaryRes;

      // Parse suggestions JSON. Strip code fences, then isolate the actual array
      // (the model sometimes wraps it in prose) before parsing.
      const cleaned = suggestRes.replace(/```json|```/g, '').trim();
      let parsedOk = false;
      try {
        const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(arrayMatch ? arrayMatch[0] : cleaned);
        if (Array.isArray(parsed) && parsed.length >= 1) {
          suggestions = parsed
            .map((s: any) => String(s).trim())
            .filter(Boolean)
            .slice(0, 3);
          parsedOk = suggestions.length > 0;
        }
      } catch {
        /* fall through to line-based salvage below */
      }

      if (!parsedOk) {
        // Salvage path: a truncated array (missing closing ]) or pretty-printed
        // JSON would otherwise leak structural lines. Drop lines that are only
        // brackets/commas, strip leading [/] + numbering + wrapping quotes so a
        // bare "[" never becomes a suggestion chip.
        suggestions = cleaned
          .split(/\n/)
          .map(l =>
            l
              .replace(/^[\[\]\s,]+|[\[\]\s,]+$/g, '')
              .replace(/^\d+\.\s*/, '')
              .replace(/^["']|["']$/g, '')
              .trim()
          )
          .filter(l => l && l !== '[' && l !== ']')
          .slice(0, 3);
      }
    }

    // Always return at least 3 suggestions
    const rolePhrases: Record<string, string[]> = {
      default: ['Got it, thanks!', 'Sounds good to me.', 'Can we schedule a quick sync?'],
      engineering: ['Let me check the codebase and get back to you.', 'I\'ll open a ticket for this.', 'Can we schedule a quick review?'],
      sales: ['I\'ll follow up with the client on this.', 'Let\'s loop in the team.', 'When works for a quick call?'],
      hr: ['I\'ll update the records accordingly.', 'Let\'s schedule a check-in.', 'I will send the documentation shortly.'],
      finance: ['I\'ll review the figures and revert.', 'Let me run the numbers and get back to you.', 'I\'ll process this by EOD.'],
    };
    const roleKey = callerRole?.toLowerCase();
    const fallback = rolePhrases[roleKey] || rolePhrases[Object.keys(rolePhrases).find(k => roleKey?.includes(k)) || 'default'] || rolePhrases.default;

    while (suggestions.length < 3) {
      suggestions.push(fallback[suggestions.length] || 'Let me check on this and get back to you.');
    }

    res.status(200).json({
      summary: summary || null,
      suggestions,
      // 'answer_draft' → suggestions[0] is a full drafted answer to a routed question;
      // 'reply' → the usual short reply suggestions.
      mode: isRoutedQuestion ? 'answer_draft' : 'reply',
      messageCount: messages.length,
      recipientContext: {
        name: recipientName,
        role: recipientRole,
        organization: recipientOrg,
      },
    });
  } catch (error: any) {
    console.error('[Aida] Conversation context error:', error);
    res.status(500).json({ error: 'Failed to generate conversation context.' });
  }
};

/**
 * POST /api/v1/aida/writing-suggestions
 * Gives real-time writing completions/suggestions as the user types.
 */
export const getAidaWritingSuggestions = async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, conversationId } = req.body;
    const userId = (req.user as any)?._id;

    if (!message || message.length < 3) {
      res.status(200).json({ suggestions: [] });
      return;
    }

    const conv = await Conversation.findById(conversationId).populate('users', 'full_name org_role');
    const recipient = conv?.users?.find((u: any) => String(u._id) !== String(userId));
    const recipientName = (recipient as any)?.full_name || 'them';

    // Pull last 5 messages for short-term conversational context and use them as
    // a brain seed query — surfaces facts the typing user might not remember.
    let conversationContext = '';
    let brainKnowledge = '';
    let contextRecall = ''; // a named recall hint when a missed meeting/announcement is relevant
    if (conversationId) {
      const recent = await Message.find({ chat: conversationId })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('sender', 'full_name username')
        .lean();
      conversationContext = (await buildTranscriptLines(
        recent.reverse(),
        String(conversationId),
        !!(conv as any)?.isGroupChat,
        (m: any) => (m.sender?.full_name || m.sender?.username || 'User')
      )).join('\n');

      const { resolveUserOrg } = await import('../utils/orgResolver');
      const typer = await User.findById(userId);
      const org = typer ? await resolveUserOrg(typer) : null;

      if (org && hasPinecone()) {
        try {
          const seed = `${conversationContext}\n${message}`.slice(-1500);
          const embedding = await generateEmbedding(seed);
          if (embedding.length > 0) {
            const namespace = org.pineconeNamespace || `org-${org._id}`;
            // Pull more context (top 6) so cross-thread facts the user wasn't part
            // of (e.g. a meeting they missed) can surface.
            const matches = await queryVectors(embedding, 6, org._id.toString(), namespace);
            const relevant = matches.filter((m) => m.score >= 0.55);
            brainKnowledge = relevant
              .map((m: any) => `• ${m.metadata?.chunk || ''}`)
              .join('\n');

            // contextRecall: if the strongest match comes from a meeting/calendar
            // source the user likely missed, name it so they *remember* it.
            const meetingMatch = relevant.find(
              (m: any) => m.metadata?.sourceKind === 'meeting' || m.metadata?.sourceKind === 'calendar'
            );
            if (meetingMatch) {
              const title = (meetingMatch.metadata as any)?.title || 'a recent meeting';
              const ts = (meetingMatch.metadata as any)?.createdAtTs;
              const when = ts ? new Date(Number(ts)).toLocaleDateString() : '';
              contextRecall = `Heads up: "${title}"${when ? ` (${when})` : ''} covered this — ${((meetingMatch.metadata as any)?.chunk || '').slice(0, 180)}…`;
            }
          }
        } catch (brainErr) {
          console.error('[Writing Suggestions] brain seed failed:', brainErr);
        }
      }
    }

    const systemPrompt = `You are Aida, a smart writing assistant inside a company chat. Provide 3 short, contextual message completions (max 12 words each) for a user typing to ${recipientName}. If the brain-knowledge block contains a fact relevant to the conversation, use it — these are facts the typing user may not know off the top of their head. Return ONLY a JSON array of 3 strings, no preamble.`;
    const userPrompt = [
      conversationContext ? `Recent conversation:\n${conversationContext}` : '',
      brainKnowledge ? `Brain knowledge from this organization:\n${brainKnowledge}` : '',
      `The user has typed: "${message}". Suggest 3 helpful completions or follow-ups.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const raw = await callAIDA(systemPrompt, userPrompt, 200, 0.6);
    let suggestions: string[] = [];
    const cleaned = raw.replace(/```json|```/g, '').trim();
    try {
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      const parsed = JSON.parse(arrayMatch ? arrayMatch[0] : cleaned);
      if (Array.isArray(parsed)) {
        suggestions = parsed.map(s => String(s).trim()).filter(Boolean).slice(0, 3);
      }
    } catch {
      /* fall through */
    }
    if (suggestions.length === 0) {
      // Same structural-line guard as conversation-context so a bare "[" from a
      // truncated/pretty-printed array never surfaces as a suggestion chip.
      suggestions = cleaned
        .split('\n')
        .map(s =>
          s
            .replace(/^[\[\]\s,]+|[\[\]\s,]+$/g, '')
            .replace(/^\d+\.\s*/, '')
            .replace(/^["']|["']$/g, '')
            .trim()
        )
        .filter(s => s && s !== '[' && s !== ']')
        .slice(0, 3);
    }

    res.status(200).json({ suggestions, contextRecall: contextRecall || null });
  } catch (error) {
    res.status(200).json({ suggestions: ['How are you?', 'Let me know if you can help.', 'Thanks!'], contextRecall: null });
  }
};

// ─── POST /api/v1/aida/draft ─── Context-Aware Draft on Behalf (Deep Aida) ─────
//
// Unlike single-channel smart-compose (which only sees the email/thread), this
// drafts ONE complete reply using the full conversation history + any meeting
// transcripts shared by this group in the last 14 days + open action items the
// other party owes. That cross-channel context is what no single-channel AI can do.
export const aidaDraft = async (req: Request, res: Response): Promise<void> => {
  try {
    const { conversationId, currentMessage } = req.body;
    const userId = (req.user as any)?._id;

    if (!conversationId) {
      res.status(400).json({ message: 'conversationId is required' });
      return;
    }

    const conv = await Conversation.findById(conversationId).populate('users', 'full_name username org_role');
    if (!conv) {
      res.status(404).json({ message: 'Conversation not found' });
      return;
    }

    const me = await User.findById(userId).select('full_name username');
    const myName = me?.full_name || me?.username || 'me';
    const participants = (conv.users as any[]) || [];
    const others = participants.filter((u: any) => String(u._id) !== String(userId));
    const otherIds = others.map((u: any) => u._id);
    const recipientName = conv.isGroupChat
      ? (conv.chatName || 'the group')
      : (others[0]?.full_name || others[0]?.username || 'them');

    // 1. Last ~20 messages of the thread (chronological).
    const recent = await Message.find({ chat: conversationId })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('sender', 'full_name username')
      .lean();
    const draftLines: string[] = [];
    for (const m of recent.reverse() as any[]) {
      const text = await resolveMessageText(m, String(conversationId), !!conv.isGroupChat);
      if (text) draftLines.push(`${m.sender?.full_name || m.sender?.username || 'User'}: ${text}`);
      else if (!m.content) draftLines.push(`${m.sender?.full_name || m.sender?.username || 'User'}: [${m.message_type || 'media'}]`);
      // encrypted-but-unreadable (private DM) lines are dropped
    }
    const conversationContext = draftLines.join('\n');

    // 2. Meeting transcripts shared by this group in the last 14 days. Prefer a direct
    //    chatId link; otherwise fall back to meetings among these participants.
    const { Meeting } = await import('../models/meeting');
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const meetings = await Meeting.find({
      status: 'ended',
      endedAt: { $gte: since },
      $or: [
        { chatId: conversationId },
        { host: { $in: [userId, ...otherIds] }, attendees: { $in: [userId, ...otherIds] } },
      ],
    })
      .sort({ endedAt: -1 })
      .limit(3)
      .select('title summary transcriptRaw endedAt')
      .lean();

    const meetingContext = meetings
      .map((m: any) => {
        const when = m.endedAt ? new Date(m.endedAt).toLocaleDateString() : '';
        const body = (m.summary || m.transcriptRaw || '').slice(0, 1200);
        return `Meeting "${m.title}"${when ? ` (${when})` : ''}:\n${body}`;
      })
      .join('\n\n');

    // 3. Open action items the OTHER party owes (so the draft can chase them).
    let actionItemContext = '';
    if (otherIds.length > 0) {
      const openItems = await Task.find({
        source: 'meeting',
        assignedTo: { $in: otherIds },
        status: { $ne: 'done' },
      })
        .sort({ createdAt: -1 })
        .limit(8)
        .select('title assignedToName')
        .lean();
      actionItemContext = openItems
        .map((t: any) => `• ${t.title}${t.assignedToName ? ` (owner: ${t.assignedToName})` : ''}`)
        .join('\n');
    }

    // 4. Org brain knowledge (same Pinecone retrieval as suggestions).
    let brainKnowledge = '';
    let usedOrgContext = false;
    try {
      const { resolveUserOrg } = await import('../utils/orgResolver');
      const org = me ? await resolveUserOrg(me) : null;
      if (org && hasPinecone()) {
        const seed = `${conversationContext}\n${currentMessage || ''}`.slice(-1500);
        const embedding = await generateEmbedding(seed);
        if (embedding.length > 0) {
          const namespace = org.pineconeNamespace || `org-${org._id}`;
          const matches = await queryVectors(embedding, 6, org._id.toString(), namespace);
          const relevant = matches.filter((m) => m.score >= 0.55);
          brainKnowledge = relevant.map((m: any) => `• ${m.metadata?.chunk || ''}`).join('\n');
          usedOrgContext = relevant.length > 0;
        }
      }
    } catch (brainErr) {
      console.error('[Aida Draft] brain retrieval failed:', brainErr);
    }

    const systemPrompt = `You are Aida, drafting a reply ON BEHALF OF ${myName} inside a company chat. Write ONE complete, professional, contextually accurate reply to the latest message from ${recipientName}. Use the full context provided — conversation history, meeting notes, and open action items — to sound informed and specific. Do not invent facts. Write only the message body (no greetings like "Hi Aida", no quotes, no preamble, no signature).`;

    const userPrompt = [
      conversationContext ? `Conversation so far:\n${conversationContext}` : '',
      meetingContext ? `Relevant meeting notes (last 14 days):\n${meetingContext}` : '',
      actionItemContext ? `Open action items owed by ${recipientName}:\n${actionItemContext}` : '',
      brainKnowledge ? `Organization knowledge:\n${brainKnowledge}` : '',
      currentMessage ? `${myName} has started typing: "${currentMessage}". Continue/complete in that direction.` : `Write the best reply ${myName} could send next.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const draft = await callAIDA(systemPrompt, userPrompt, 1500, 0.6);

    if (!draft) {
      res.status(200).json({ draft: '', meetingCount: meetings.length, usedOrgContext });
      return;
    }

    res.status(200).json({
      draft: draft.replace(/^["']|["']$/g, '').trim(),
      meetingCount: meetings.length,
      usedOrgContext,
    });
  } catch (error: any) {
    console.error('[Aida Draft] error:', error?.message || error);
    res.status(500).json({ message: 'Failed to generate draft' });
  }
};
