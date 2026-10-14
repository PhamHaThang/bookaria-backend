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
    router.get('/library/assets', adminController.getLibraryAssets);
    router.post('/library/assets', adminController.createLibraryAsset);
    router.patch('/library/assets/:assetId', adminController.updateLibraryAsset);
    router.delete('/library/assets/:assetId', adminController.deleteLibraryAsset);
    router.post('/asset-categories', adminController.createCategory);
    router.patch('/asset-categories/:categoryId', adminController.updateCategory);
    router.delete('/asset-categories/:categoryId', adminController.deleteCategory);
    router.get('/bookaria-markers', adminController.getBookariaMarkers);
    router.post('/bookaria-markers', adminController.createBookariaMarker);
    router.patch('/bookaria-markers/:markerId', adminController.updateBookariaMarker);
    router.get('/jobs', adminController.getJobs);
    router.post('/jobs/:jobId/retry', adminController.retryJob);
    router.get('/audit-logs', adminController.getAuditLogs);
    router.get('/users', adminController.getUsers);
    router.post('/users', adminController.createUser);
    router.get('/users/:userId', adminController.getUser);
    router.patch('/users/:userId', adminController.updateUser);

    return router;
};
