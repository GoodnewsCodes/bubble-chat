// Mock Data Store for Bubble Chat Mobile App

export interface Message {
  id: string;
  text: string;
  sender: 'me' | 'other' | 'system';
  senderName?: string;
  senderIsBot?: boolean;
  time: string;
  timestamp: Date;
  reactions?: string[];
  isPinned?: boolean;
  isRead?: boolean;
  status?: 'queued' | 'sent' | 'delivered' | 'sending' | 'failed';
  message_type?: string;
  is_announcement?: boolean;
  isSystem?: boolean;
  mediaUrl?: string | null;
  media_url?: string | null;
  media_metadata?: { duration?: number; mime_type?: string; [k: string]: any } | null;
  transcript?: string | null;
  // Populated quoted message when this is a reply (shape from backend formatMessage).
  parent_message?: {
    id: string;
    content?: string | null;
    sender?: { full_name?: string | null; uniqueTag?: string | null } | null;
  } | null;
}

export interface Chat {
  id: string;
  name: string;
  avatar: string | null;
  isGroupChat: boolean;
  latestMessage: string | null;
  time: string;
  unreadCount: number;
  isPinned: boolean;
  isMuted?: boolean;
  isOnline: boolean;
  typingUser: { name: string; username: string } | null;
  status: 'read_own' | 'unread_other' | 'typing' | 'sent' | 'delivered' | 'read_other_all';
  /** True when the latest message in this chat was sent by the current user. */
  latestFromMe?: boolean;
  updatedAt: Date;
  bio: string;
  email: string;
  phone: string;
  organization: string;
  org_role: string;
  messages: Message[];
  /** Used for Friends tab */
  isFriend?: boolean;
  otherUserId?: string | null;
}

export interface Contact {
  id: string;
  name: string;
  avatar: string | null;
  isOnline: boolean;
  username: string;
  bio: string;
  email: string;
  phone: string;
  org_role: string;
  category?: 'friend' | 'work' | 'other';
  organization?: string;
}

// ─── Conversations ───────────────────────────────────────────────────────────

let chats: Chat[] = [
  // ── Work group chats ────────────────────────────────────
  {
    id: '1',
    name: 'Design Team',
    avatar: null,
    isGroupChat: true,
    latestMessage: "Let's review the mobile splash screens",
    time: '10:42 AM',
    unreadCount: 3,
    isPinned: true,
    isOnline: false,
    typingUser: null,
    status: 'read_own',
    updatedAt: new Date(Date.now() - 1000 * 60 * 15),
    bio: 'Official collaborative space for the Bubblespace product and UI design team.',
    email: 'design@bubblespace.co',
    phone: 'N/A',
    organization: 'Bubblespace',
    org_role: 'Core Creators',
    messages: [
      { id: '1001', text: 'Hey team, how is the new design coming along?', sender: 'other', senderName: 'Alex Rivera', time: '10:00 AM', timestamp: new Date(Date.now() - 1000 * 60 * 60) },
      { id: '1002', text: 'Almost done, just finishing up the mobile views.', sender: 'me', time: '10:05 AM', timestamp: new Date(Date.now() - 1000 * 60 * 55) },
      { id: '1003', text: 'Great! Let me know if you need any assets.', sender: 'other', senderName: 'Sarah Chen', time: '10:10 AM', timestamp: new Date(Date.now() - 1000 * 60 * 50) },
      { id: '1004', text: "Let's review the mobile splash screens", sender: 'other', senderName: 'David Kim', time: '10:42 AM', timestamp: new Date(Date.now() - 1000 * 60 * 15) },
    ],
  },
  {
    id: '6',
    name: 'Engineering Hub',
    avatar: null,
    isGroupChat: true,
    latestMessage: '🚀 Deployment to staging complete!',
    time: '9:55 AM',
    unreadCount: 1,
    isPinned: false,
    isOnline: false,
    typingUser: null,
    status: 'unread_other',
    updatedAt: new Date(Date.now() - 1000 * 60 * 25),
    bio: 'Engineering discussions, code reviews, and sprint planning.',
    email: 'eng@bubblespace.co',
    phone: 'N/A',
    organization: 'Bubblespace',
    org_role: 'Engineering',
    messages: [
      { id: '6001', text: 'Anyone reviewed the PR for the auth module?', sender: 'other', senderName: 'Marcus Johnson', time: '9:40 AM', timestamp: new Date(Date.now() - 1000 * 60 * 40) },
      { id: '6002', text: 'On it. Looks clean so far.', sender: 'me', time: '9:50 AM', timestamp: new Date(Date.now() - 1000 * 60 * 30) },
      { id: '6003', text: '🚀 Deployment to staging complete!', sender: 'other', senderName: 'Helena Rostova', time: '9:55 AM', timestamp: new Date(Date.now() - 1000 * 60 * 25) },
    ],
  },
  {
    id: '7',
    name: 'Company Announcements',
    avatar: null,
    isGroupChat: true,
    latestMessage: '📢 Welcome our 50 new employee additions!',
    time: '9:30 AM',
    unreadCount: 0,
    isPinned: true,
    isMuted: true,
    isOnline: false,
    typingUser: null,
    status: 'read_own',
    updatedAt: new Date(Date.now() - 1000 * 60 * 90),
    bio: 'Broadcast channel for all organization announcements and general updates.',
    email: 'info@bubblespace.co',
    phone: 'N/A',
    organization: 'Bubblespace',
    org_role: 'Official Channel',
    messages: [
      { id: '7001', text: '📢 Welcome our 50 new employee additions!', sender: 'other', senderName: 'HR Team', time: '9:30 AM', timestamp: new Date(Date.now() - 1000 * 60 * 90) },
    ],
  },

  // ── Friends ─────────────────────────────────────────────
  {
    id: '2',
    name: 'Alex Rivera',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=160&auto=format&fit=crop',
    isGroupChat: false,
    latestMessage: 'The mobile view is super responsive now! 🎉',
    time: '10:15 AM',
    unreadCount: 0,
    isPinned: true,
    isOnline: true,
    typingUser: null,
    status: 'read_other_all',
    updatedAt: new Date(Date.now() - 1000 * 60 * 42),
    isFriend: true,
    bio: 'Product Designer at Bubblespace. Love crafting sweet interfaces.',
    email: 'alex.rivera@bubblespace.co',
    phone: '+1 (555) 019-2834',
    organization: 'Bubblespace',
    org_role: 'Lead Designer',
    messages: [
      { id: '2001', text: 'Hello! Did you get a chance to check the updated desktop dashboard layout?', sender: 'other', time: '10:12 AM', timestamp: new Date(Date.now() - 1000 * 60 * 45) },
      { id: '2002', text: 'The mobile view is super responsive now! 🎉', sender: 'other', time: '10:15 AM', timestamp: new Date(Date.now() - 1000 * 60 * 42) },
    ],
  },
  {
    id: '4',
    name: 'Sarah Chen',
    avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=160&auto=format&fit=crop',
    isGroupChat: false,
    latestMessage: 'Are we still on for the 2 PM meeting?',
    time: 'Yesterday',
    unreadCount: 2,
    isPinned: false,
    isOnline: true,
    typingUser: null,
    status: 'unread_other',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
    isFriend: true,
    bio: 'Full Stack Engineer. Code architect, bubble tea enthusiast.',
    email: 'sarah.chen@bubblespace.co',
    phone: '+1 (555) 014-9821',
    organization: 'Bubblespace',
    org_role: 'Senior Developer',
    messages: [
      { id: '4001', text: 'Hey there! I pushed the latest branch with the websocket fixes.', sender: 'other', time: 'Yesterday', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 25) },
      { id: '4002', text: 'Are we still on for the 2 PM meeting?', sender: 'other', time: 'Yesterday', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24) },
    ],
  },
  {
    id: '5',
    name: 'David Kim',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=160&auto=format&fit=crop',
    isGroupChat: false,
    latestMessage: "Sounds good. Let's catch up later today.",
    time: 'Monday',
    unreadCount: 0,
    isPinned: false,
    isOnline: true,
    typingUser: null,
    status: 'delivered',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3),
    bio: 'Product Manager. Obsessed with user-centric design and analytics.',
    email: 'david.kim@bubblespace.co',
    phone: '+1 (555) 012-7489',
    organization: 'Bubblespace',
    org_role: 'Product Manager',
    messages: [
      { id: '5001', text: 'Hey David, I updated the sprint board tasks.', sender: 'me', time: 'Monday', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3 - 1000 * 60 * 10) },
      { id: '5002', text: "Sounds good. Let's catch up later today.", sender: 'other', time: 'Monday', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3) },
    ],
  },
  {
    id: '8',
    name: 'Jamie Lee',
    avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=160&auto=format&fit=crop',
    isGroupChat: false,
    latestMessage: 'Loved the design! 😍 Ship it.',
    time: 'Mon',
    unreadCount: 0,
    isPinned: false,
    isOnline: false,
    typingUser: null,
    status: 'read_other_all',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 4),
    isFriend: true,
    bio: 'UX Researcher & coffee addict. Here for the wireframes.',
    email: 'jamie.lee@bubblespace.co',
    phone: '+1 (555) 011-5566',
    organization: 'Bubblespace',
    org_role: 'UX Researcher',
    messages: [
      { id: '8001', text: 'Can you share the Figma file for the onboarding flow?', sender: 'me', time: 'Mon', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 4 - 1000 * 60 * 10) },
      { id: '8002', text: 'Loved the design! 😍 Ship it.', sender: 'other', time: 'Mon', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 4) },
    ],
  },
];

// ─── Contacts (not yet messaged) ─────────────────────────────────────────────

let contacts: Contact[] = [
  {
    id: '101',
    name: 'Emily Watson',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=160&auto=format&fit=crop',
    isOnline: false,
    username: 'emily_w',
    bio: 'Marketing Director. Transforming brands with bubbly narratives.',
    email: 'emily.watson@bubblespace.co',
    phone: '+1 (555) 016-4322',
    org_role: 'Marketing Director',
    category: 'work',
  },
  {
    id: '102',
    name: 'Marcus Johnson',
    avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=160&auto=format&fit=crop',
    isOnline: true,
    username: 'marcus_j',
    bio: 'DevOps Engineer. Dockerizing the world one container at a time.',
    email: 'marcus.j@bubblespace.co',
    phone: '+1 (555) 017-8890',
    org_role: 'DevOps Engineer',
    category: 'work',
  },
  {
    id: '103',
    name: 'Helena Rostova',
    avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=160&auto=format&fit=crop',
    isOnline: true,
    username: 'helena_r',
    bio: 'Security Analyst. I break things so you don\'t have to.',
    email: 'helena.r@bubblespace.co',
    phone: '+1 (555) 018-3344',
    org_role: 'Security Lead',
    category: 'work',
  },
  {
    id: '104',
    name: 'Tyler Durden',
    avatar: null,
    isOnline: false,
    username: 'tyler_d',
    bio: 'First rule of Bubblespace: you do not talk about Bubblespace.',
    email: 'soap@bubblespace.co',
    phone: '+1 (555) 019-0000',
    org_role: 'Project Consultant',
    category: 'other',
  },
  {
    id: '105',
    name: 'Priya Sharma',
    avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=160&auto=format&fit=crop',
    isOnline: true,
    username: 'priya_s',
    bio: 'Data Scientist. Turning numbers into narratives.',
    email: 'priya.sharma@bubblespace.co',
    phone: '+1 (555) 021-8833',
    org_role: 'Data Scientist',
    category: 'work',
  },
  {
    id: '106',
    name: 'Liam Torres',
    avatar: 'https://images.unsplash.com/photo-1463453091185-61582044d556?w=160&auto=format&fit=crop',
    isOnline: false,
    username: 'liam_t',
    bio: 'iOS Developer. Swift enthusiast. Sushi connoisseur.',
    email: 'liam.t@bubblespace.co',
    phone: '+1 (555) 022-4411',
    org_role: 'iOS Engineer',
    category: 'friend',
  },
  {
    id: '107',
    name: 'Zoë Hartman',
    avatar: 'https://images.unsplash.com/photo-1548142813-c348350df52b?w=160&auto=format&fit=crop',
    isOnline: true,
    username: 'zoe_h',
    bio: 'Brand Strategist. Turning ideas into iconic identities.',
    email: 'zoe.h@bubblespace.co',
    phone: '+1 (555) 023-6677',
    org_role: 'Brand Strategist',
    category: 'friend',
  },
];

// ─── Time util ───────────────────────────────────────────────────────────────

function getFormattedTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

type ChatCallback = () => void;
const subscribers: Set<ChatCallback> = new Set();

export const subscribeToChats = (callback: ChatCallback) => {
  subscribers.add(callback);
  return () => { subscribers.delete(callback); };
};

const notifySubscribers = () => { subscribers.forEach(cb => cb()); };

// ─── API ─────────────────────────────────────────────────────────────────────

export const getChats = (): Chat[] =>
  [...chats].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

export const getContacts = (): Contact[] => [...contacts];

export const getChatById = (id: string): Chat | undefined => {
  const found = chats.find(c => c.id === id);
  if (found) return found;

  const contact = contacts.find(c => c.id === id);
  if (contact) {
    const newChat: Chat = {
      id: contact.id,
      name: contact.name,
      avatar: contact.avatar,
      isGroupChat: false,
      latestMessage: null,
      time: 'Now',
      unreadCount: 0,
      isPinned: false,
      isOnline: contact.isOnline,
      typingUser: null,
      status: 'delivered',
      updatedAt: new Date(),
      bio: contact.bio,
      email: contact.email,
      phone: contact.phone,
      organization: 'Bubblespace',
      org_role: contact.org_role,
      messages: [],
    };
    chats.push(newChat);
    notifySubscribers();
    return newChat;
  }

  return undefined;
};

export const sendMessage = (chatId: string, text: string): Message => {
  const chat = getChatById(chatId);
  if (!chat) throw new Error('Chat not found');

  const newMsg: Message = {
    id: Math.random().toString(36).substring(7),
    text,
    sender: 'me',
    time: getFormattedTime(new Date()),
    timestamp: new Date(),
  };

  chat.messages.push(newMsg);
  chat.latestMessage = text;
  chat.time = newMsg.time;
  chat.updatedAt = new Date();
  chat.status = 'delivered';

  notifySubscribers();
  simulateReply(chat);
  return newMsg;
};

// ─── Auto replies ─────────────────────────────────────────────────────────────

const AUTO_RESPONSES: Record<string, string[]> = {
  '1': [
    "Perfect, let's look at those on our next sync!",
    'Great updates, please upload the Figma links so the dev team can start looking.',
    'Btw Sarah Chen, can you make sure we use standard border variables?',
    "Sounds great, let's aim to finalize the prototype by tomorrow.",
  ],
  '2': [
    'Awesome, looks neat!',
    'I really love how clean the typography is now.',
    'Do you think we should adjust the padding inside cards?',
    'Thanks! I will review and get back to you shortly.',
  ],
  '4': [
    'Yes, still on! Let\'s use the same meeting room link.',
    'Awesome, I checked your commit and verified the CSS styles are consistent.',
    'Will bring coffee ☕️',
    'Should we invite Marcus too?',
  ],
  '5': [
    'Excellent, thanks for taking care of that.',
    'I will verify the sprints and move them to ready.',
    'Looks good to go!',
  ],
  '6': [
    'All green on my end 🟢',
    'Nice, the new pipeline cuts build time in half.',
    'Should I spin up the preview environment too?',
  ],
  '7': [
    'Thanks for the update!',
    'Looking forward to meeting the new team members.',
  ],
  '8': [
    'Sure, sharing the link now!',
    'Did you check the user research report I sent last week?',
    'Love the direction — very on-brand.',
  ],
  '101': [
    'Hello! Thanks for reaching out. What can I do for you today?',
    'Our new marketing campaign draft is ready for review.',
    'Yes, I will send over the guidelines.',
  ],
  '102': [
    'Docker containers are healthy and running!',
    'I just finished setting up the staging pipeline.',
    'Let me know if you need help debugging the environment.',
  ],
  '103': [
    'Audit completed. Security settings are solid.',
    'Checking logs now.',
    'Everything is clear!',
  ],
  '104': [
    "It's a beautiful day to write clean code 🫧",
    "What's the status of the build?",
  ],
  '105': [
    'The latest model accuracy is at 94.2% 🤓',
    'Running a new dataset sweep — will share results by EOD.',
  ],
  '106': [
    'Swift 6 migration is almost done!',
    'The app loads in under 1.2 seconds now, very smooth.',
  ],
  '107': [
    'Brand refresh doc is ready for your review.',
    'Love the new color palette — very premium!',
  ],
};

const simulateReply = (chat: Chat) => {
  setTimeout(() => {
    chat.typingUser = {
      name: chat.isGroupChat ? 'Alex Rivera' : chat.name,
      username: chat.isGroupChat ? 'alex_r' : chat.name.toLowerCase().replace(/\s/g, '_'),
    };
    chat.status = 'typing';
    notifySubscribers();

    setTimeout(() => {
      chat.typingUser = null;

      const responses = AUTO_RESPONSES[chat.id] || [
        "Sounds interesting, let's chat about it!",
        'Got it!',
        'Thanks for letting me know!',
      ];
      const replyText = responses[Math.floor(Math.random() * responses.length)];

      const replyMsg: Message = {
        id: Math.random().toString(36).substring(7),
        text: replyText,
        sender: 'other',
        senderName: chat.isGroupChat ? 'Alex Rivera' : undefined,
        time: getFormattedTime(new Date()),
        timestamp: new Date(),
      };

      chat.messages.push(replyMsg);
      chat.latestMessage = chat.isGroupChat ? `${replyMsg.senderName}: ${replyText}` : replyText;
      chat.time = replyMsg.time;
      chat.updatedAt = new Date();
      chat.status = 'unread_other';
      chat.unreadCount += 1;

      notifySubscribers();
    }, 2000);
  }, 1000);
};

// ─── Custom Folder Tabs ───────────────────────────────────────────────────────

let folders: string[] = ["All", "Unread", "Friends", "Work", "Archive"];

export const getFolders = (): string[] => [...folders];

export const addFolder = (name: string) => {
  if (name && !folders.includes(name)) {
    folders.push(name);
    notifySubscribers();
  }
};

// ─── Contact Creator ─────────────────────────────────────────────────────────

export const addMockContact = (name: string, category: string): Contact => {
  const id = Math.random().toString(36).substring(7);
  const username = name.toLowerCase().replace(/\s/g, "_");
  
  const avatars = [
    "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=160&auto=format&fit=crop",
    "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=160&auto=format&fit=crop",
    "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=160&auto=format&fit=crop",
    "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=160&auto=format&fit=crop",
    null
  ];
  const avatar = avatars[Math.floor(Math.random() * avatars.length)];

  const newContact: Contact = {
    id,
    name,
    avatar,
    isOnline: Math.random() > 0.5,
    username,
    bio: `Workspace participant focusing on ${category} projects.`,
    email: `${username}@bubblespace.co`,
    phone: `+1 (555) 033-${Math.floor(1000 + Math.random() * 9000)}`,
    org_role: "Team Collaborator",
    category: category.toLowerCase() as any,
  };

  contacts.push(newContact);

  AUTO_RESPONSES[id] = [
    `Hi! Thanks for messaging. Let's collaborate on this new ${category} folder.`,
    `Awesome, I'm online now. Let me know what you need.`,
    `Received! Will check and reply in a bit.`
  ];

  notifySubscribers();
  return newContact;
};

export const createMockGroupChat = (name: string): Chat => {
  const id = Math.random().toString(36).substring(7);
  const newChat: Chat = {
    id,
    name,
    avatar: null,
    isGroupChat: true,
    latestMessage: "Group created! Start collaborating.",
    time: "Now",
    unreadCount: 0,
    isPinned: false,
    isOnline: false,
    typingUser: null,
    status: 'read_own',
    updatedAt: new Date(),
    bio: `Collaborative space for the ${name} team.`,
    email: `${name.toLowerCase().replace(/\s/g, "_")}@bubblespace.co`,
    phone: 'N/A',
    organization: 'Bubblespace',
    org_role: 'Group Chat',
    messages: [
      { id: Math.random().toString(36).substring(7), text: `Welcome to the ${name} group!`, sender: 'other', senderName: 'System', time: 'Now', timestamp: new Date() }
    ],
  };

  chats.push(newChat);
  notifySubscribers();
  return newChat;
};

// ─── Plus Button Event Bus ────────────────────────────────────────────────────

type PlusButtonListener = () => void;
const plusListeners: Set<PlusButtonListener> = new Set();

export const subscribeToPlusButton = (callback: PlusButtonListener) => {
  plusListeners.add(callback);
  return () => { plusListeners.delete(callback); };
};

export const triggerPlusButton = () => {
  plusListeners.forEach(cb => cb());
};

export const deleteChat = (id: string) => {
  const index = chats.findIndex(c => c.id === id);
  if (index !== -1) {
    chats.splice(index, 1);
    notifySubscribers();
  }
};

export const deleteContact = (id: string) => {
  const index = contacts.findIndex(c => c.id === id);
  if (index !== -1) {
    contacts.splice(index, 1);
    notifySubscribers();
  }
};

