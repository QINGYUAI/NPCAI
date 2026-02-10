/**
 * 文件上传 - 头像等静态资源
 */
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

/** 允许的图片 MIME 类型 */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
/** 最大文件大小 2MB */
const MAX_SIZE = 2 * 1024 * 1024;

/** 上传头像，返回可访问路径 */
export async function uploadAvatar(req: Request, res: Response) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ code: -1, message: '请选择图片文件' });
    }
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ code: -1, message: '仅支持 JPG、PNG、GIF、WebP 格式' });
    }
    if (file.size > MAX_SIZE) {
      return res.status(400).json({ code: -1, message: '图片不超过 2MB' });
    }

    const ext = path.extname(file.originalname) || '.jpg';
    const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext.toLowerCase()) ? ext : '.jpg';
    const filename = `${randomUUID()}${safeExt}`;
    const dir = path.join(process.cwd(), 'uploads', 'avatars');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const destPath = path.join(dir, filename);
    fs.renameSync(file.path, destPath);

    // 返回相对路径，前端拼接 baseURL
    const urlPath = `/uploads/avatars/${filename}`;
    res.json({ code: 0, data: { url: urlPath } });
  } catch (err) {
    console.error('uploadAvatar:', err);
    res.status(500).json({ code: -1, message: '上传失败' });
  }
}
