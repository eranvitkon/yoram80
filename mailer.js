const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.FROM_EMAIL || 'yoram80@yourdomain.com';
const SITE_URL = process.env.SITE_URL || 'https://yoram80.onrender.com';

async function notifyNewPhoto(uploaderName, photoId, allUsers) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('[mailer] SENDGRID_API_KEY not set, skipping email');
    return;
  }

  const recipients = allUsers.filter(u => u.email);
  if (recipients.length === 0) return;

  const messages = recipients.map(user => ({
    to: user.email,
    from: { email: FROM_EMAIL, name: 'יום הולדת 80 לסבא יורם 🎂' },
    subject: `📸 ${uploaderName} העלה/ה תמונה חדשה!`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; background: #F9F6F1; padding: 32px; border-radius: 12px;">
        <h2 style="color: #2D5A3D; margin-top: 0;">🎂 יום הולדת 80 לסבא יורם</h2>
        <p style="font-size: 16px; color: #333;">
          שלום ${user.name}!<br><br>
          <strong>${uploaderName}</strong> העלה/ה תמונה חדשה לגלריה.
        </p>
        <a href="${SITE_URL}" style="display: inline-block; background: #2D5A3D; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 16px;">
          לצפייה בגלריה →
        </a>
        <p style="color: #999; font-size: 12px; margin-top: 24px;">
          קיבלת מייל זה כי נרשמת לאירוע יום הולדת 80 לסבא יורם
        </p>
      </div>
    `
  }));

  try {
    await sgMail.send(messages);
    console.log(`[mailer] Sent ${messages.length} notification emails`);
  } catch (err) {
    console.error('[mailer] Error sending emails:', err.response?.body || err.message);
  }
}

module.exports = { notifyNewPhoto };
