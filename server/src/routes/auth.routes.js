import { Router } from 'express';
import { login, logout, refresh, getMe } from '../controllers/auth.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import validate from '../middleware/validate.middleware.js';
import { loginSchema } from '../validators/auth.validator.js';

const router = Router();

router.post('/login', validate(loginSchema), login);
router.post('/logout', verifyJWT, logout);
router.post('/refresh', refresh); // no verifyJWT: the token itself is the credential
router.get('/me', verifyJWT, getMe);

export default router;
