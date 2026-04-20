/**
 * 文件上传 - 头像等静态资源
 */
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

/** 允许的图片 MIME 类型 */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
/** 头像：较小；底图：较大 */
const AVATAR_MAX = 2 * 1024 * 1024;
const IMAGE_MAX = 8 * 1024 * 1024;

/** 内部：统一处理图片上传（限制类型、大小、重命名到目标目录）并返回 URL */
async function handleImageUpload(
  req: Request,
  res: Response,
  subdir: 'avatars' | 'images',
  maxSize: number,
  readableMax: string,
) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ code: -1, message: '请选择图片文件' });
    }
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ code: -1, message: '仅支持 JPG、PNG、GIF、WebP 格式' });
    }
    if (file.size > maxSize) {
      return res.status(400).json({ code: -1, message: `图片不超过 ${readableMax}` });
    }

    const ext = path.extname(file.originalname) || '.jpg';
    const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext.toLowerCase()) ? ext : '.jpg';
    const filename = `${randomUUID()}${safeExt}`;
    const dir = path.join(process.cwd(), 'uploads', subdir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const destPath = path.join(dir, filename);
    fs.renameSync(file.path, destPath);

    const urlPath = `/uploads/${subdir}/${filename}`;
    res.json({ code: 0, data: { url: urlPath } });
  } catch (err) {
    console.error(`upload ${subdir}:`, err);
    res.status(500).json({ code: -1, message: '上传失败' });
  }
}

/** 上传头像（2MB 上限，存 uploads/avatars） */
export async function uploadAvatar(req: Request, res: Response) {
  await handleImageUpload(req, res, 'avatars', AVATAR_MAX, '2MB');
}

/** 上传通用图片（8MB 上限，存 uploads/images）；用于沙盒底图等大图 */
export async function uploadImage(req: Request, res: Response) {
  await handleImageUpload(req, res, 'images', IMAGE_MAX, '8MB');
}
