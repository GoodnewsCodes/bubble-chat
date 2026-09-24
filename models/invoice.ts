import mongoose, { Document, Schema } from 'mongoose';

export interface IInvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number; // in cents
  amount: number;    // quantity * unitPrice
}

export interface IInvoice extends Document {
  user_id: mongoose.Types.ObjectId;
  invoiceNumber: string;
  recipientName?: string;
  recipientEmail?: string;
  recipientUserId?: mongoose.Types.ObjectId;
  items: IInvoiceItem[];
  subtotal: number;  // cents
  tax?: number;      // cents
  discount?: number; // cents
  totalAmount: number; // cents
  currency: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
  dueDate?: Date;
  paidAt?: Date;
  notes?: string;
  pdfUrl?: string;
  stripePaymentLink?: string;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceItemSchema = new Schema<IInvoiceItem>(
  {
    description: { type: String, required: true },
    quantity:    { type: Number, required: true, min: 1 },
    unitPrice:   { type: Number, required: true },
    amount:      { type: Number, required: true },
  },
  { _id: false }
);

const InvoiceSchema = new Schema<IInvoice>(
  {
    user_id:          { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    invoiceNumber:    { type: String, required: true, unique: true },
    recipientName:    { type: String },
    recipientEmail:   { type: String },
    recipientUserId:  { type: Schema.Types.ObjectId, ref: 'User' },
    items:            [InvoiceItemSchema],
    subtotal:         { type: Number, required: true },
    tax:              { type: Number, default: 0 },
    discount:         { type: Number, default: 0 },
    totalAmount:      { type: Number, required: true },
    currency:         { type: String, default: 'usd' },
    status: {
      type: String,
      enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled'],
      default: 'draft',
    },
    dueDate:            { type: Date },
    paidAt:             { type: Date },
    notes:              { type: String },
    pdfUrl:             { type: String },
    stripePaymentLink:  { type: String },
  },
  { timestamps: true }
);

InvoiceSchema.index({ user_id: 1, createdAt: -1 });
InvoiceSchema.index({ status: 1, dueDate: 1 }); // For overdue queries

export const Invoice = mongoose.model<IInvoice>('Invoice', InvoiceSchema);
