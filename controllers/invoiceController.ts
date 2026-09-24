import { Request, Response } from 'express';
import { Invoice } from '../models/invoice';
import { createNotification } from './notificationController';
import { logActivity } from './activityLogController';

// ─── Helper: generate sequential invoice number ───────────────────────────────
const generateInvoiceNumber = async (): Promise<string> => {
  const count = await Invoice.countDocuments();
  const pad = String(count + 1).padStart(5, '0');
  return `INV-${new Date().getFullYear()}-${pad}`;
};

// ─── POST /api/v1/payment/invoice ────────────────────────────────────────────
export const createInvoice = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { recipientName, recipientEmail, recipientUserId, items, tax, discount, currency, dueDate, notes } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'At least one line item is required' });
    }

    // Compute amounts
    const processedItems = items.map((item: any) => ({
      description: item.description,
      quantity:    item.quantity || 1,
      unitPrice:   Math.round(item.unitPrice * 100), // Store in cents
      amount:      Math.round(item.quantity * item.unitPrice * 100),
    }));

    const subtotal    = processedItems.reduce((sum, i) => sum + i.amount, 0);
    const taxAmount   = Math.round((tax || 0) * 100);
    const discAmount  = Math.round((discount || 0) * 100);
    const totalAmount = subtotal + taxAmount - discAmount;

    const invoiceNumber = await generateInvoiceNumber();

    const invoice = await Invoice.create({
      user_id:          userId,
      invoiceNumber,
      recipientName,
      recipientEmail,
      recipientUserId,
      items:            processedItems,
      subtotal,
      tax:              taxAmount,
      discount:         discAmount,
      totalAmount,
      currency:         currency || 'usd',
      dueDate,
      notes,
      status:           'draft',
    });

    await logActivity({
      actor:       userId,
      action:      'invoice_created',
      entityId:    String(invoice._id),
      entityType:  'Invoice',
      entityLabel: invoiceNumber,
    });

    res.status(201).json({ message: 'Invoice created', invoice });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to create invoice', error: err.message });
  }
};

// ─── GET /api/v1/payment/invoices ────────────────────────────────────────────
export const getInvoices = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const status = req.query.status as string | undefined;
    const filter: any = { user_id: userId };
    if (status) filter.status = status;

    const invoices = await Invoice.find(filter).sort({ createdAt: -1 }).lean();
    res.status(200).json({ invoices });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to fetch invoices', error: err.message });
  }
};

// ─── GET /api/v1/payment/invoice/:id ─────────────────────────────────────────
export const getInvoiceById = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const invoice = await Invoice.findOne({ _id: req.params.id, user_id: userId });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.status(200).json({ invoice });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to fetch invoice', error: err.message });
  }
};

// ─── PUT /api/v1/payment/invoice/:id ─────────────────────────────────────────
export const updateInvoice = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { status, dueDate, notes, recipientEmail } = req.body;
    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, user_id: userId },
      { ...(status && { status }), ...(dueDate && { dueDate }), ...(notes && { notes }), ...(recipientEmail && { recipientEmail }) },
      { returnDocument: 'after' }
    );

    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    // If being marked as sent, notify recipient user if on platform
    if (status === 'sent' && invoice.recipientUserId) {
      await createNotification({
        recipient:   invoice.recipientUserId,
        sender:      userId,
        type:        'invoice_sent',
        title:       `Invoice ${invoice.invoiceNumber} received`,
        body:        `You have received an invoice for ${(invoice.totalAmount / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
        entityId:    String(invoice._id),
        entityType:  'Invoice',
      });
    }

    if (status === 'paid') {
      invoice.paidAt = new Date();
      await invoice.save();
    }

    await logActivity({
      actor:       userId,
      action:      status === 'sent' ? 'invoice_sent' : 'payment_made',
      entityId:    String(invoice._id),
      entityType:  'Invoice',
      entityLabel: invoice.invoiceNumber,
    });

    res.status(200).json({ message: 'Invoice updated', invoice });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to update invoice', error: err.message });
  }
};

// ─── DELETE /api/v1/payment/invoice/:id ─────────────────────────────────────
export const deleteInvoice = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const invoice = await Invoice.findOneAndDelete({ _id: req.params.id, user_id: userId, status: 'draft' });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found or cannot delete non-draft invoice' });
    res.status(200).json({ message: 'Invoice deleted' });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to delete invoice', error: err.message });
  }
};
