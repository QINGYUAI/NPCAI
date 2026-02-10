/**
 * 文件上传路由
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadAvatar } from '../controllers/upload.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(process.cwd(), 'uploads', 'avatars');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

export const uploadRouter = Router();

/** 上传头像 */
uploadRouter.post('/avatar', upload.single('file'), uploadAvatar);
