const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host  : process.env.EMAIL_HOST,
  port  : parseInt(process.env.EMAIL_PORT),
  secure: false,
  auth  : {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

const sendOTPEmail = async (to, otp) => {
  await transporter.sendMail({
    from   : process.env.EMAIL_FROM,
    to,
    subject: 'Kode OTP Reimburse App',
    html   : `
      <div style="font-family: Arial, sans-serif; max-width: 400px; margin: auto;">
        <h2 style="color: #1877F2;">Kode OTP Anda</h2>
        <p>Gunakan kode berikut untuk verifikasi:</p>
        <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px;
                    color: #1877F2; text-align: center; padding: 20px;
                    background: #f0f4ff; border-radius: 8px;">
          ${otp}
        </div>
        <p style="color: #666; margin-top: 16px;">
          Kode berlaku selama <strong>1 menit</strong>.<br>
          Jangan bagikan kode ini kepada siapapun.
        </p>
      </div>
    `,
  });
};

const sendMail = async ({ from, to, subject, html }) => {
  await transporter.sendMail({ from, to, subject, html });
};

module.exports = { sendOTPEmail, sendMail };