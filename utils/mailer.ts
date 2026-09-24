import { Resend } from 'resend';
import dotenv from 'dotenv';
dotenv.config();

// ──────────────────────────────────────────────────────
// Resend HTTP API — works on Railway (no SMTP blocking)
// Set RESEND_API_KEY in your Railway environment variables
// Get a free key at https://resend.com (3,000 emails/month free)
// ──────────────────────────────────────────────────────

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.SMTP_FROM_EMAIL || 'noreply@yourdomain.com';
const FROM_NAME = process.env.SMTP_FROM_NAME || 'Bubble Chat';

/**
 * Preference gate for NON-transactional email. Returns true when the user has an
 * email address and hasn't opted out via privacy_settings.email_notifications.
 * Never use this for OTP / password-reset / onboarding mail — those are
 * transactional and must always send.
 */
export const emailAllowed = (user: any): boolean =>
  !!user?.email && user?.privacy_settings?.email_notifications !== false;

export const sendMail = async (to: string, subject: string, html: string, attachments?: any[]) => {
  if (!process.env.RESEND_API_KEY) {
    console.error(`❌ Mailer: RESEND_API_KEY is missing from environment variables.`);
    throw new Error('RESEND_API_KEY is not configured');
  }

  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_ADDRESS}>`,
      to,
      subject,
      html,
      ...(attachments ? { attachments } : {}),
    });

    if (error) {
      console.error(`❌ Resend API Error for ${to}:`, error);
      throw new Error(error.message);
    }

    // console.log(`✅ Email successfully queued for transmission to ${to}. Tracking ID: ${data?.id}`);
    return data;
  } catch (err: any) {
    console.error(`❌ Mailer critical failure for ${to}:`, err.message);
    throw err;
  }
};

/**
 * Send OTP email with the Bubble space light/lavender theme template
 */
export const sendOTPEmail = async (to: string, name: string, otp: string) => {
  const subject = 'Your Bubble Verification Code';
  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #f8fafc; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(139, 92, 246, 0.05);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #f5f3ff 0%, #e0e7ff 100%); padding: 40px 32px; text-align: center; border-bottom: 1px solid #ddd6fe;">
        <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #7c3aed; text-transform: uppercase;">BUBBLE</div>
        <div style="font-size: 11px; color: #8b5cf6; letter-spacing: 4px; text-transform: uppercase; margin-top: 4px; font-weight: 600;">The Future of Transmission</div>
      </div>
      
      <!-- Body -->
      <div style="padding: 40px 32px; background-color: #ffffff;">
        <h2 style="color: #0f172a; font-size: 20px; font-weight: 700; margin: 0 0 12px;">Security Flash 🔐</h2>
        <p style="font-size: 15px; line-height: 1.7; color: #334155; margin: 0 0 12px;">Hello ${name},</p>
        <p style="font-size: 15px; line-height: 1.7; color: #475569; margin: 0 0 28px;">
          A verification code has been requested for your Bubble account. Use the code below to complete your action:
        </p>
        
        <!-- OTP Box -->
        <div style="background-color: #f5f3ff; border: 1px solid #ddd6fe; padding: 28px 20px; border-radius: 16px; text-align: center; margin: 0 0 28px;">
          <div style="font-size: 42px; font-weight: 900; letter-spacing: 12px; color: #7c3aed; font-variant-numeric: tabular-nums;">${otp}</div>
          <div style="font-size: 12px; color: #8b5cf6; margin-top: 10px; letter-spacing: 1px; font-weight: 600;">EXPIRES IN 10 MINUTES</div>
        </div>

        <p style="font-size: 13px; color: #64748b; line-height: 1.6; margin: 0;">
          If you did not request this code, please ignore this email. Your account remains secure.
        </p>
      </div>

      <!-- Footer -->
      <div style="padding: 20px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center;">
        <p style="font-size: 11px; color: #94a3b8; margin: 0; letter-spacing: 1px; font-weight: 600;">BUBBLE SPACE · SECURE TRANSMISSIONS</p>
      </div>
    </div>
  `;
  return await sendMail(to, subject, html);
};

/**
 * Send Password Reset email with OTP
 */
export const sendPasswordResetEmail = async (to: string, name: string, otp: string) => {
  const subject = 'Reset Your Bubble Password';

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #f8fafc; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(139, 92, 246, 0.05);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #f5f3ff 0%, #e0e7ff 100%); padding: 40px 32px; text-align: center; border-bottom: 1px solid #ddd6fe;">
        <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #7c3aed; text-transform: uppercase;">BUBBLE</div>
        <div style="font-size: 11px; color: #8b5cf6; letter-spacing: 4px; text-transform: uppercase; margin-top: 4px; font-weight: 600;">The Future of Transmission</div>
      </div>
      
      <!-- Body -->
      <div style="padding: 40px 32px; background-color: #ffffff;">
        <h2 style="color: #0f172a; font-size: 20px; font-weight: 700; margin: 0 0 12px;">Reset Password ⚡️</h2>
        <p style="font-size: 15px; line-height: 1.7; color: #334155; margin: 0 0 12px;">Hello ${name},</p>
        <p style="font-size: 15px; line-height: 1.7; color: #475569; margin: 0 0 28px;">
          You requested to reset your password. Use the verification code below on the reset screen. This code will expire in 15 minutes.
        </p>
        
        <!-- OTP Box -->
        <div style="background-color: #f5f3ff; border: 1px solid #ddd6fe; padding: 28px 20px; border-radius: 16px; text-align: center; margin: 0 0 28px;">
          <div style="font-size: 42px; font-weight: 900; letter-spacing: 12px; color: #7c3aed; font-variant-numeric: tabular-nums;">${otp}</div>
          <div style="font-size: 12px; color: #8b5cf6; margin-top: 10px; letter-spacing: 1px; font-weight: 600;">EXPIRES IN 15 MINUTES</div>
        </div>

        <p style="font-size: 13px; color: #64748b; line-height: 1.6; margin: 0;">
          If you did not request a password reset, you can safely ignore this email.
        </p>
      </div>

      <!-- Footer -->
      <div style="padding: 20px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center;">
        <p style="font-size: 11px; color: #94a3b8; margin: 0; letter-spacing: 1px; font-weight: 600;">BUBBLE SPACE · SECURE TRANSMISSIONS</p>
      </div>
    </div>
  `;
  return await sendMail(to, subject, html);
};

/**
 * Send Task/Goal Reminder email with AIda integration styling
 */
export const sendTaskReminderEmail = async (to: string, name: string, taskTitle: string, dueDate: Date, description?: string) => {
  const subject = `Your upcoming objective: ${taskTitle}`;
  const timeString = dueDate.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #f8fafc; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(139, 92, 246, 0.05);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #f5f3ff 0%, #e0e7ff 100%); padding: 40px 32px; text-align: center; border-bottom: 1px solid #ddd6fe;">
        <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #7c3aed; text-transform: uppercase;">BUBBLE</div>
        <div style="font-size: 11px; color: #8b5cf6; letter-spacing: 4px; text-transform: uppercase; margin-top: 4px; font-weight: 600;">AIda Automated Systems</div>
      </div>
      
      <!-- Body -->
      <div style="padding: 40px 32px; background-color: #ffffff;">
        <h2 style="color: #0f172a; font-size: 20px; font-weight: 700; margin: 0 0 12px;">Task Deadline Reminder ⏳</h2>
        <p style="font-size: 15px; line-height: 1.7; color: #334155; margin: 0 0 12px;">Hello ${name},</p>
        <p style="font-size: 15px; line-height: 1.7; color: #475569; margin: 0 0 28px;">
          This is an automated reminder regarding an upcoming task assigned to you in your Bubble Workspace.
        </p>
        
        <!-- Task Box -->
        <div style="background-color: #f5f3ff; border: 1px solid #ddd6fe; padding: 28px 20px; border-radius: 16px; text-align: left; margin: 0 0 28px;">
          <h3 style="font-size: 18px; font-weight: 700; color: #7c3aed; margin: 0 0 8px;">${taskTitle}</h3>
          <p style="font-size: 13px; color: #8b5cf6; margin: 0 0 12px; font-weight: 600;">Due: <strong>${timeString}</strong></p>
          ${description ? `<p style="font-size: 14px; color: #475569; margin: 0; line-height: 1.5;">${description}</p>` : ''}
        </div>

        <p style="font-size: 13px; color: #5a7a9a; line-height: 1.6; margin: 0; text-align: center;">
          <a href="${process.env.FRONTEND_URL || 'http://localhost:8080'}/workspace" style="display: inline-block; padding: 14px 28px; background-color: #8b5cf6; color: #ffffff; font-weight: 700; text-decoration: none; border-radius: 12px; letter-spacing: 1px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.2);">GO TO WORKSPACE</a>
        </p>
      </div>

      <!-- Footer -->
      <div style="padding: 20px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center;">
        <p style="font-size: 11px; color: #94a3b8; margin: 0; letter-spacing: 1px; font-weight: 600;">BUBBLE CHAT · SECURE TRANSMISSIONS</p>
      </div>
    </div>
  `;
  return await sendMail(to, subject, html);
};

export const sendMessageRequestEmail = async (to: string, targetName: string, senderName: string, senderOrg: string) => {
  const subject = `Message Request from ${senderName} at ${senderOrg}`;
  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #f8fafc; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(139, 92, 246, 0.05);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #f5f3ff 0%, #e0e7ff 100%); padding: 40px 32px; text-align: center; border-bottom: 1px solid #ddd6fe;">
        <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #7c3aed; text-transform: uppercase;">BUBBLE</div>
        <div style="font-size: 11px; color: #8b5cf6; letter-spacing: 4px; text-transform: uppercase; margin-top: 4px; font-weight: 600;">EXTERNAL TRANSMISSION</div>
      </div>
      <!-- Body -->
      <div style="padding: 40px 32px; background-color: #ffffff;">
        <h2 style="color: #0f172a; font-size: 20px; font-weight: 700; margin: 0 0 12px;">New Message Request 👋</h2>
        <p style="font-size: 15px; line-height: 1.7; color: #334155; margin: 0 0 12px;">Hello ${targetName},</p>
        <p style="font-size: 15px; line-height: 1.7; color: #475569; margin: 0 0 28px;">
          You have received a new cross-organization message request from <strong>${senderName}</strong> at <strong>${senderOrg}</strong>.
        </p>
        <div style="text-align: center; margin: 0 0 28px;">
          <a href="${process.env.FRONTEND_URL || 'http://localhost:8080'}/messages" style="display: inline-block; padding: 14px 28px; background-color: #8b5cf6; color: #ffffff; font-weight: 800; font-size: 14px; text-decoration: none; border-radius: 12px; letter-spacing: 1px; box-shadow: 0 4px 14px rgba(139,92,246,0.3);">
            VIEW REQUEST
          </a>
        </div>
        <p style="font-size: 13px; color: #64748b; line-height: 1.6; margin: 0;">
          If you do not wish to connect with this sender, you can simply decline the request inside your Bubble workspace.
        </p>
      </div>
      <!-- Footer -->
      <div style="padding: 20px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center;">
        <p style="font-size: 11px; color: #94a3b8; margin: 0; letter-spacing: 1px; font-weight: 600;">BUBBLE CHAT · SECURE TRANSMISSIONS</p>
      </div>
    </div>
  `;
  return await sendMail(to, subject, html);
};

/**
 * Send meeting transcripts & AI summaries to participants in light lavender theme
 */
export const sendMeetingTranscriptEmail = async (
  to: string,
  name: string,
  meetingTitle: string,
  transcriptRaw: string,
  summary?: string,
  actionItems?: { text: string; assignedToName?: string | null }[]
) => {
  const subject = `Meeting Intelligence: ${meetingTitle}`;

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Build action items HTML
  const actionItemsHtml = (actionItems && actionItems.length > 0)
    ? `
      <div style="margin-bottom: 28px;">
        <h3 style="font-size: 15px; font-weight: 800; color: #1f2030; margin: 0 0 12px; display: flex; align-items: center; gap: 8px;">
          ✅ Action Items (${actionItems.length})
        </h3>
        ${actionItems.map((ai, idx) => `
          <div style="display: flex; align-items: flex-start; background: #f0fdf4; border-radius: 14px; padding: 12px; margin-bottom: 8px; border: 1px solid rgba(34,197,94,0.15);">
            <div style="min-width: 24px; height: 24px; border-radius: 12px; background: #22c55e; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-right: 12px; margin-top: 1px; flex-shrink: 0;">
              ${idx + 1}
            </div>
            <div>
              <p style="margin: 0; font-size: 13.5px; color: #1f2030; line-height: 1.5;">${ai.text}</p>
              ${ai.assignedToName ? `<p style="margin: 4px 0 0; font-size: 11px; font-weight: 700; color: #6c5ce7;">@ ${ai.assignedToName}</p>` : ''}
            </div>
          </div>
        `).join('')}
      </div>`
    : '';

  // Build summary HTML
  const summaryHtml = summary
    ? `
      <div style="background: rgba(108,92,231,0.06); border-left: 4px solid #6c5ce7; border-radius: 18px; padding: 20px 22px; margin-bottom: 24px;">
        <p style="font-size: 11px; font-weight: 800; color: #6c5ce7; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px;">🧠 Aida's Meeting Intelligence</p>
        <p style="font-size: 13.5px; color: #1f2030; line-height: 1.8; margin: 0;">${summary}</p>
      </div>`
    : '';

  // Attach full transcript as markdown
  const mdContent = `# Meeting Minutes: ${meetingTitle}\nDate: ${dateStr}\n\n## Summary\n${summary || 'Unavailable'}\n\n## Action Items\n${(actionItems || []).map((ai, i) => `${i + 1}. ${ai.text}${ai.assignedToName ? ` (@ ${ai.assignedToName})` : ''}`).join('\n') || 'None'}\n\n## Full Transcript\n${transcriptRaw || 'No transcript recorded.'}\n`;
  const attachmentBase64 = Buffer.from(mdContent).toString('base64');
  const filename = `meeting-minutes-${meetingTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'meeting'}.md`;

  const html = `
    <div style="font-family: 'Poppins', 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: 0 auto; padding: 0; background-color: #fbfbfe; border-radius: 28px; overflow: hidden; border: 1px solid #eae7fa; box-shadow: 0 15px 35px -5px rgba(108, 92, 231, 0.06);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #6c5ce7 0%, #4834d4 100%); padding: 44px 36px; text-align: center; border-bottom: 1px solid rgba(255,255,255,0.1);">
        <div style="font-size: 30px; font-weight: 900; letter-spacing: 6px; color: #ffffff; text-transform: uppercase; text-shadow: 0 2px 4px rgba(0,0,0,0.15);">BUBBLESPACE</div>
        <div style="font-size: 11px; color: rgba(255,255,255,0.75); letter-spacing: 4px; text-transform: uppercase; margin-top: 6px; font-weight: 700;">Meeting Intelligence Suite</div>
      </div>

      <!-- Body -->
      <div style="padding: 44px 36px; background-color: #ffffff;">
        <h2 style="color: #1f2030; font-size: 22px; font-weight: 800; margin: 0 0 6px; font-family: 'Space Grotesk', 'Segoe UI', sans-serif;">Meeting Minutes 📋</h2>
        <p style="font-size: 12px; color: #9a9aab; margin: 0 0 24px;">${dateStr}</p>

        <p style="font-size: 14.5px; line-height: 1.7; color: #4a5568; margin: 0 0 8px;">Hello ${name},</p>
        <p style="font-size: 14.5px; line-height: 1.7; color: #4a5568; margin: 0 0 28px;">
          Your meeting <strong style="color: #6c5ce7;">${meetingTitle}</strong> has ended. Here is Aida's full intelligence report:
        </p>

        ${summaryHtml}
        ${actionItemsHtml}

        <!-- Divider -->
        <div style="border-top: 1px solid #eae7fa; margin: 24px 0;"></div>
        <p style="font-size: 12px; color: #9a9aab; margin: 0; text-align: center;">
          The complete meeting minutes (including full transcript) are attached as a <strong>.md</strong> file for your records.
        </p>
      </div>

      <!-- Footer -->
      <div style="padding: 24px 36px; background-color: #fbfbfe; border-top: 1px solid #eae7fa; text-align: center;">
        <p style="font-size: 10px; color: #9a9aab; margin: 0; letter-spacing: 1.5px; font-weight: 700; text-transform: uppercase;">BUBBLESPACE · SECURE TRANSMISSIONS</p>
      </div>
    </div>
  `;

  return await sendMail(to, subject, html, [
    {
      content: attachmentBase64,
      filename,
    }
  ]);
};

/**
 * Send welcome email containing the AI-generated company overview summary to new members
 */
export const sendWelcomeNewMemberEmail = async (
  to: string,
  name: string,
  orgName: string,
  onboardingSummaryHtml: string
) => {
  const subject = `Welcome to ${orgName} on Bubblespace!`;
  const html = `
    <div style="font-family: 'Poppins', 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #fbfbfe; border-radius: 28px; overflow: hidden; border: 1px solid #eae7fa; box-shadow: 0 15px 35px -5px rgba(108, 92, 231, 0.06);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #6c5ce7 0%, #4834d4 100%); padding: 44px 36px; text-align: center; border-bottom: 1px solid rgba(255,255,255,0.1);">
        <div style="font-size: 30px; font-weight: 900; letter-spacing: 6px; color: #ffffff; text-transform: uppercase; text-shadow: 0 2px 4px rgba(0,0,0,0.15);">BUBBLESPACE</div>
        <div style="font-size: 11px; color: rgba(255,255,255,0.75); letter-spacing: 4px; text-transform: uppercase; margin-top: 6px; font-weight: 700;">Organization Welcome</div>
      </div>
      
      <!-- Body -->
      <div style="padding: 44px 36px; background-color: #ffffff;">
        <h2 style="color: #1f2030; font-size: 22px; font-weight: 800; margin: 0 0 14px; font-family: 'Space Grotesk', 'Segoe UI', sans-serif;">Welcome aboard! 🚀</h2>
        <p style="font-size: 14.5px; line-height: 1.7; color: #4a5568; margin: 0 0 12px;">Hello ${name},</p>
        <p style="font-size: 14.5px; line-height: 1.7; color: #4a5568; margin: 0 0 24px;">
          You have successfully joined <strong style="color: #6c5ce7;">${orgName}</strong> on Bubblespace. Here is a brief AI-compiled overview of the company to help get you up to speed instantly:
        </p>
        
        <!-- Company Profile Box -->
        <div style="background-color: #efedfb; border-left: 5px solid #6c5ce7; padding: 24px; border-radius: 18px; margin-bottom: 32px; text-align: left; font-size: 14px; line-height: 1.7; color: #2d3748; font-family: 'Segoe UI', sans-serif; box-shadow: inset 0 1px 3px rgba(108,92,231,0.05);">
          ${onboardingSummaryHtml || 'No company overview is available yet.'}
        </div>

        <div style="text-align: center; margin: 32px 0 10px;">
          <a href="${process.env.FRONTEND_URL || 'http://localhost:8080'}/dashboard" style="display: inline-block; padding: 16px 32px; background-color: #6c5ce7; color: #ffffff; font-weight: 800; font-size: 14px; text-decoration: none; border-radius: 16px; letter-spacing: 1px; box-shadow: 0 6px 20px rgba(108, 92, 231, 0.25); font-family: 'Poppins', sans-serif; transition: all 0.2s;">
            ENTER WORKSPACE
          </a>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding: 24px 36px; background-color: #fbfbfe; border-top: 1px solid #eae7fa; text-align: center;">
        <p style="font-size: 10px; color: #9a9aab; margin: 0; letter-spacing: 1px; font-weight: 700; text-transform: uppercase;">BUBBLESPACE · SECURE TRANSMISSIONS</p>
      </div>
    </div>
  `;
  return await sendMail(to, subject, html);
};

/**
 * Short "you missed a meeting" recap for org members who did NOT attend, so the
 * whole team stays caught up without receiving the full transcript.
 */
export const sendMeetingRecapEmail = async (
  to: string,
  name: string,
  meetingTitle: string,
  summary: string
) => {
  const subject = `Recap: ${meetingTitle}`;
  const html = `
    <div style="font-family: 'Poppins', 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #eae7fa;">
      <div style="background: linear-gradient(135deg, #6c5ce7 0%, #4834d4 100%); padding: 32px; text-align: center;">
        <div style="font-size: 22px; font-weight: 900; letter-spacing: 4px; color: #fff; text-transform: uppercase;">BUBBLESPACE</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.75); letter-spacing: 3px; text-transform: uppercase; margin-top: 6px; font-weight: 700;">Meeting Recap</div>
      </div>
      <div style="padding: 32px;">
        <p style="font-size: 14px; line-height: 1.7; color: #4a5568; margin: 0 0 14px;">Hi ${name}, you weren't in <strong style="color:#6c5ce7;">${meetingTitle}</strong> — here's the short version so you're caught up:</p>
        <div style="background-color: #efedfb; border-left: 5px solid #6c5ce7; padding: 20px; border-radius: 16px; font-size: 14px; line-height: 1.7; color: #2d3748;">
          ${(summary || 'No summary available.').replace(/\n/g, '<br />')}
        </div>
      </div>
      <div style="padding: 20px 32px; background-color: #fbfbfe; border-top: 1px solid #eae7fa; text-align: center;">
        <p style="font-size: 10px; color: #9a9aab; margin: 0; letter-spacing: 1px; font-weight: 700; text-transform: uppercase;">BUBBLESPACE · WORKSPACE BRAIN</p>
      </div>
    </div>
  `;
  return await sendMail(to, subject, html);
};

/**
 * Generic short digest/recap email (daily + weekly recaps, new-joiner catch-up).
 * `bodyText` is plain text; newlines become line breaks.
 */
export const sendDigestEmail = async (
  to: string,
  name: string,
  title: string,
  bodyText: string
) => {
  const html = `
    <div style="font-family: 'Poppins', 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #eae7fa;">
      <div style="background: linear-gradient(135deg, #6c5ce7 0%, #4834d4 100%); padding: 32px; text-align: center;">
        <div style="font-size: 22px; font-weight: 900; letter-spacing: 4px; color: #fff; text-transform: uppercase;">BUBBLESPACE</div>
        <div style="font-size: 10px; color: rgba(255,255,255,0.75); letter-spacing: 3px; text-transform: uppercase; margin-top: 6px; font-weight: 700;">${title}</div>
      </div>
      <div style="padding: 32px;">
        <p style="font-size: 14px; line-height: 1.7; color: #4a5568; margin: 0 0 14px;">Hi ${name},</p>
        <div style="background-color: #efedfb; border-left: 5px solid #6c5ce7; padding: 20px; border-radius: 16px; font-size: 14px; line-height: 1.7; color: #2d3748;">
          ${(bodyText || '').replace(/\n/g, '<br />')}
        </div>
      </div>
      <div style="padding: 20px 32px; background-color: #fbfbfe; border-top: 1px solid #eae7fa; text-align: center;">
        <p style="font-size: 10px; color: #9a9aab; margin: 0; letter-spacing: 1px; font-weight: 700; text-transform: uppercase;">BUBBLESPACE · WORKSPACE BRAIN</p>
      </div>
    </div>
  `;
  return await sendMail(to, title, html);
};

/**
 * Send calendar event invitation/notification email
 */
export const sendCalendarEventEmail = async (
  to: string,
  userName: string,
  eventTitle: string,
  eventType: 'meeting' | 'event' | 'task',
  startTime: Date,
  endTime: Date,
  description?: string,
  creatorName?: string
) => {
  const subject = `Invitation: ${eventTitle}`;
  const startStr = new Date(startTime).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
  const endStr = new Date(endTime).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });

  const html = `
    <div style="font-family: 'Poppins', 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #fbfbfe; border-radius: 28px; overflow: hidden; border: 1px solid #eae7fa; box-shadow: 0 15px 35px -5px rgba(108, 92, 231, 0.06);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #6c5ce7 0%, #4834d4 100%); padding: 44px 36px; text-align: center; border-bottom: 1px solid rgba(255,255,255,0.1);">
        <div style="font-size: 30px; font-weight: 900; letter-spacing: 6px; color: #ffffff; text-transform: uppercase; text-shadow: 0 2px 4px rgba(0,0,0,0.15);">BUBBLESPACE</div>
        <div style="font-size: 11px; color: rgba(255,255,255,0.75); letter-spacing: 4px; text-transform: uppercase; margin-top: 6px; font-weight: 700;">Calendar & Workspace Schedule</div>
      </div>
      
      <!-- Body -->
      <div style="padding: 44px 36px; background-color: #ffffff;">
        <h2 style="color: #1f2030; font-size: 22px; font-weight: 800; margin: 0 0 14px; font-family: 'Space Grotesk', 'Segoe UI', sans-serif;">
          New ${eventType === 'meeting' ? 'Meeting 📅' : 'Event 📢'} Scheduled
        </h2>
        <p style="font-size: 14.5px; line-height: 1.7; color: #4a5568; margin: 0 0 12px;">Hello ${userName},</p>
        <p style="font-size: 14.5px; line-height: 1.7; color: #4a5568; margin: 0 0 28px;">
          ${creatorName || 'A teammate'} has scheduled a new ${eventType} on Bubblespace.
        </p>

        <!-- Event Card -->
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 24px; border-radius: 20px; text-align: left; margin-bottom: 28px; box-shadow: 0 4px 12px rgba(0,0,0,0.01);">
          <h3 style="font-size: 16px; font-weight: 800; color: #6c5ce7; margin: 0 0 12px; font-family: 'Poppins', 'Segoe UI', sans-serif;">
            ${eventTitle}
          </h3>
          <p style="font-size: 13.5px; color: #4a5568; margin: 0 0 8px; line-height: 1.5;">
            <strong>Starts:</strong> ${startStr}
          </p>
          <p style="font-size: 13.5px; color: #4a5568; margin: 0 0 16px; line-height: 1.5;">
            <strong>Ends:</strong> ${endStr}
          </p>
          ${description ? `
            <div style="border-top: 1px solid #e2e8f0; padding-top: 12px; font-size: 13px; color: #718096; line-height: 1.6;">
              <strong>Description:</strong><br />
              ${description.replace(/\n/g, '<br />')}
            </div>
          ` : ''}
        </div>

        <div style="text-align: center; margin: 28px 0 10px;">
          <a href="${process.env.FRONTEND_URL || 'http://localhost:8080'}/dashboard/calls" style="display: inline-block; padding: 14px 28px; background-color: #6c5ce7; color: #ffffff; font-weight: 800; font-size: 13px; text-decoration: none; border-radius: 14px; letter-spacing: 1px; box-shadow: 0 6px 20px rgba(108, 92, 231, 0.2); font-family: 'Poppins', sans-serif; transition: all 0.2s;">
            VIEW ON CALENDAR
          </a>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding: 24px 36px; background-color: #fbfbfe; border-top: 1px solid #eae7fa; text-align: center;">
        <p style="font-size: 10px; color: #9a9aab; margin: 0; letter-spacing: 1.5px; font-weight: 700; text-transform: uppercase;">BUBBLESPACE · SECURE TRANSMISSIONS</p>
      </div>
    </div>
  `;

  return await sendMail(to, subject, html);
};

/**
 * Notify a user that Aida detected a repeating event pattern.
 * The confirm/dismiss links hit the backend endpoint with a signed token.
 */
export const sendRecurringPatternEmail = async (
  to: string,
  name: string,
  patternTitle: string,
  occurrences: number,
  confirmUrl: string,
  dismissUrl: string
) => {
  const subject = `🔁 Aida noticed a pattern: "${patternTitle}"`;
  const html = `
    <div style="font-family:'Poppins','Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #eae7fa;box-shadow:0 15px 35px -5px rgba(108,92,231,0.06);">
      <div style="background:linear-gradient(135deg,#6c5ce7 0%,#4834d4 100%);padding:36px;text-align:center;">
        <div style="font-size:26px;font-weight:900;letter-spacing:5px;color:#fff;text-transform:uppercase;">BUBBLESPACE</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.75);letter-spacing:3px;text-transform:uppercase;margin-top:5px;font-weight:700;">Aida · Pattern Intelligence</div>
      </div>
      <div style="padding:36px;">
        <h2 style="color:#1f2030;font-size:20px;font-weight:800;margin:0 0 8px;">Pattern Detected 🔁</h2>
        <p style="font-size:14px;line-height:1.7;color:#4a5568;margin:0 0 10px;">Hi ${name},</p>
        <p style="font-size:14px;line-height:1.7;color:#4a5568;margin:0 0 24px;">
          Aida has noticed that you've had <strong style="color:#6c5ce7;">"${patternTitle}"</strong> scheduled
          <strong>${occurrences} times</strong> recently. Would you like to make it an official recurring event?
        </p>
        <div style="background:#efedfb;border-left:4px solid #6c5ce7;border-radius:16px;padding:18px 22px;margin-bottom:28px;">
          <p style="font-size:13px;color:#6c5ce7;font-weight:700;margin:0 0 6px;">✦ What happens when you confirm:</p>
          <ul style="font-size:13px;color:#4a5568;margin:0;padding-left:18px;line-height:1.8;">
            <li>This event gets flagged as recurring in your calendar</li>
            <li>Future instances appear with a yellow recurring indicator</li>
            <li>You won't get notified about this pattern again</li>
          </ul>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <a href="${confirmUrl}" style="flex:1;min-width:140px;display:inline-block;padding:14px 20px;background:#6c5ce7;color:#fff;font-weight:800;font-size:13px;text-decoration:none;border-radius:14px;text-align:center;letter-spacing:0.5px;box-shadow:0 6px 20px rgba(108,92,231,0.25);">
            ✓ Yes, make it recurring
          </a>
          <a href="${dismissUrl}" style="flex:1;min-width:120px;display:inline-block;padding:14px 20px;background:#f8fafc;color:#64748b;font-weight:700;font-size:13px;text-decoration:none;border-radius:14px;text-align:center;border:1px solid #e2e8f0;">
            ✗ No thanks
          </a>
        </div>
      </div>
      <div style="padding:20px 36px;background:#fbfbfe;border-top:1px solid #eae7fa;text-align:center;">
        <p style="font-size:10px;color:#9a9aab;margin:0;letter-spacing:1.5px;font-weight:700;text-transform:uppercase;">BUBBLESPACE · AIDA PATTERN INTELLIGENCE</p>
      </div>
    </div>
  `;
  return await sendMail(to, subject, html);
};

