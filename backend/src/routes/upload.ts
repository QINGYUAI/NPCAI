/**
 * 文件上传路由
 * - /avatar: 头像，2MB
 * - /image: 通用图片（沙盒底图等），8MB
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadAvatar, uploadImage } from '../controllers/upload.js';

/** 共用 multer storage：头像与通用图片都先写入 uploads/tmp，再由 controller 改名 */
const tmpStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), 'uploads', 'tmp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, _file, cb) => {
    cb(null, `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  },
});

/** 头像上传：2MB 上限 */
const uploadAvatarMw = multer({
  storage: tmpStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
});

/** 通用图片上传：8MB 上限 */
const uploadImageMw = multer({
  storage: tmpStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
});

export const uploadRouter = Router();

uploadRouter.post('/avatar', uploadAvatarMw.single('file'), uploadAvatar);
uploadRouter.post('/image', uploadImageMw.single('file'), uploadImage);
