import { Router } from 'express';
import { requireAuth, requireRole } from '../../middlewares';
import { adminController } from './admin.controller';

export const adminRouter = () => {
    const router = Router();
    router.use(requireAuth, requireRole('ADMIN'), adminController.authorize);

    router.get('/users', adminController.getUsers);
    router.post('/users', adminController.createUser);
    router.get('/users/:userId', adminController.getUser);
    router.patch('/users/:userId', adminController.updateUser);

    return router;
};
