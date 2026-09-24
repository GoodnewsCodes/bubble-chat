import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';

// Spool files safely to the local OS temporary directory
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, os.tmpdir());
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
  }
});

// Multer Config with Big File Limit
export const handleUpload = multer({
  storage,
  limits: {
    // Limits the max file size to 1GB for high capacity sharing
    fileSize: 1024 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    // Block explicitly raw executable payload MIME types natively at the stream layer
    if (file.mimetype === 'application/x-msdownload' || file.mimetype === 'application/x-sh' || file.mimetype === 'application/x-executable') {
      return cb(new Error('Executables and malicious shell files are not allowed.'));
    }
    cb(null, true);
  },
});
