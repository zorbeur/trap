const { z } = require('zod');

const EmailAddressSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

const AttachmentSchema = z.object({
  filename: z.string(),
  content_type: z.string(),
  content_base64: z.string().refine((val) => {
    // Basic check for base64 string length to not exceed 15MB when decoded
    // 15 MB = 15 * 1024 * 1024 bytes = 15,728,640 bytes.
    // Base64 size = (bytes / 3) * 4. So max base64 length ~ 20,971,520 chars.
    return val.length <= 20971520;
  }, { message: "Attachment exceeds 15MB limit" }),
});

const SendTemplatedEmailSchema = z.object({
  to: EmailAddressSchema,
  cc: z.array(EmailAddressSchema).optional(),
  template_id: z.string(),
  priority: z.enum(['high', 'normal', 'low']).optional().default('normal'),
  template_data: z.record(z.any()),
  attachments: z.array(AttachmentSchema).optional(),
  metadata: z.record(z.any()).optional(),
});

module.exports = {
  SendTemplatedEmailSchema,
};
