import { Router } from 'express';
import { requireAuth, requireRole } from '../../middlewares';
import { adminController } from './admin.controller';

export const adminRouter = () => {
    const router = Router();
    router.use(requireAuth, requireRole('ADMIN'), adminController.authorize);

    router.get('/dashboard', adminController.getDashboard);
    router.get('/moderation', adminController.getModerationQueue);
    router.get('/books', adminController.getModerationBooks);
    router.get('/books/:bookId', adminController.getModerationBook);
    router.post('/books/:bookId/takedown', adminController.takeDownBook);
    router.post('/books/:bookId/reinstate', adminController.reinstateBook);
    router.post('/books/:bookId/reports/dismiss', adminController.dismissReports);
    router.get('/users', adminController.getUsers);
    router.post('/users', adminController.createUser);
    router.get('/users/:userId', adminController.getUser);
    router.patch('/users/:userId', adminController.updateUser);

    return router;
};
