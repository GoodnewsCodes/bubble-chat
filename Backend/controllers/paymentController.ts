import { Request, Response } from 'express';
import Stripe from 'stripe';
import { User } from '../models/users';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: '2025-02-24.acacia' as any,
});

/**
 * Create a Stripe Checkout Session
 * POST /api/v1/payment/checkout
 */
export const createCheckoutSession = async (req: Request, res: Response) => {
  const { userId, isAnonymous, planType } = req.body;

  try {
    let customerEmail: string | undefined;
    let resolvedUser: any = null;

    if (!isAnonymous && userId) {
      resolvedUser = await User.findById(userId).select('full_name email uniqueTag isPremium');
      if (resolvedUser) customerEmail = resolvedUser.email;
    } else {
      // 👻 Phantom alias for complete financial privacy
      customerEmail = `ghost-${Math.floor(Math.random() * 90000)}@bubble.local`;
    }

    const planLabel = planType === 'premium' ? 'Bubble Premium Access' : 'Frequency Extension';
    const planDescription = isAnonymous ? 'Phantom Level Transaction' : 'Standard Broadcast Clearance';
    const amountCents = planType === 'premium' ? 500 : 999; // $5.00 / $9.99

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: customerEmail,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: planLabel,
              description: planDescription,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        userId: userId || 'anonymous',
        planType: planType || 'standard',
        isAnonymous: isAnonymous ? 'true' : 'false',
      },
      success_url: `${process.env.CLIENT_URL || 'http://localhost:8080'}/payments?status=success&plan=${planType}`,
      cancel_url: `${process.env.CLIENT_URL || 'http://localhost:8080'}/payments?status=canceled`,
    });

    res.status(200).json({
      message: 'Checkout session created successfully.',
      session: {
        id: session.id,
        url: session.url,
        status: session.status,
        payment_status: session.payment_status,
        customer_email: customerEmail,
        amount_total: amountCents / 100,
        currency: 'usd',
        plan: {
          type: planType || 'standard',
          label: planLabel,
          description: planDescription,
          is_anonymous: isAnonymous ?? false,
        },
        expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      },
      user: resolvedUser
        ? {
          id: resolvedUser._id,
          full_name: resolvedUser.full_name || null,
          email: resolvedUser.email || null,
          uniqueTag: resolvedUser.uniqueTag || null,
          current_premium_status: resolvedUser.isPremium,
        }
        : { mode: 'anonymous' },
    });
  } catch (error: any) {
    res.status(500).json({ message: 'Payment session creation failed: ' + error.message });
  }
};

/**
 * Stripe Webhook — confirms payment and upgrades user
 * POST /api/v1/payment/webhook
 */
export const stripeWebhook = async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
  } catch (err: any) {
    return res.status(400).json({ message: `Webhook verification failed: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    const planType = session.metadata?.planType;
    const amount = (session.amount_total || 0) / 100;

    // console.log(`✅ Payment confirmed: $${amount} — plan: ${planType} — user: ${userId}`);

    if (userId && userId !== 'anonymous') {
      try {
        await User.findByIdAndUpdate(userId, { isPremium: true });
        // console.log(`🔐 Premium upgraded for user: ${userId}`);
      } catch (err) {
        console.error('Premium upgrade failed after payment:', err);
      }
    }
  }

  res.status(200).json({
    received: true,
    event_type: event.type,
    event_id: event.id,
  });
};

/* --- LEDGER ENDPOINTS --- */

import { Transaction } from '../models/transaction';
import { Goal } from '../models/goal';

export const getTransactions = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const transactions = await Transaction.find({ user_id: userId }).sort({ createdAt: -1 });
    res.status(200).json({ transactions });
  } catch (error: any) {
    res.status(500).json({ message: 'Failed to fetch transactions: ' + error.message });
  }
};

export const withdrawFunds = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { amount, destination_account } = req.body;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (!amount || typeof amount !== 'number') return res.status(400).json({ message: "Invalid amount" });

    // Validate balance logic would go here internally. 
    // Create actual Stripe transfer/payout mapping
    const transferRes = await stripe.transfers.create({
      amount: amount * 100, // Converting dollars to cents usually
      currency: "usd",
      destination: destination_account || 'acct_1OuXXXXX', // Mocked or provided Connect account ID
    });

    const tx = await Transaction.create({
      user_id: userId,
      type: 'withdrawal',
      amount: amount,
      status: 'completed',
      source: 'stripe_transfer',
      description: `Withdrawn to account ${destination_account || 'default_connect'}`
    });

    res.status(200).json({ message: "Withdrawal successful", transfer: transferRes, transaction: tx });
  } catch (error: any) {
    res.status(500).json({ message: 'Failed to withdraw: ' + error.message });
  }
};

export const depositFunds = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { amount, source } = req.body;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (!amount || typeof amount !== 'number') return res.status(400).json({ message: "Invalid amount" });

    // Using PaymentIntents or TopUps to add to internal ledger
    const tx = await Transaction.create({
      user_id: userId,
      type: 'deposit',
      amount: amount,
      status: 'completed',
      source: source || 'stripe_deposit',
      description: `Deposit received via ${source || 'card'}`
    });

    res.status(200).json({ message: "Deposit successful", transaction: tx });
  } catch (error: any) {
    res.status(500).json({ message: 'Failed to deposit: ' + error.message });
  }
};

/* --- GOALS ENDPOINTS --- */

export const createGoal = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { title, targetAmount, currency, type, members } = req.body;

    const goal = await Goal.create({
      user_id: userId,
      title,
      targetAmount,
      currency: currency || 'usd',
      type: type || 'individual',
      members: members || [userId],
    });

    res.status(201).json({ message: "Goal created successfully", goal });
  } catch (error: any) {
    res.status(500).json({ message: 'Failed to create goal: ' + error.message });
  }
};

export const getGoals = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const goals = await Goal.find({ $or: [{ user_id: userId }, { members: userId }] }).sort({ createdAt: -1 });
    res.status(200).json({ goals });
  } catch (error: any) {
    res.status(500).json({ message: 'Failed to fetch goals: ' + error.message });
  }
};

export const contributeToGoal = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { goalId, amount } = req.body;

    const goal = await Goal.findById(goalId);
    if (!goal) return res.status(404).json({ message: "Goal not found" });

    goal.currentAmount += amount;
    await goal.save();

    await Transaction.create({
      user_id: userId,
      type: 'expense',
      amount: amount,
      status: 'completed',
      source: 'opay_or_stripe',
      description: `Contribution to Goal: ${goal.title}`
    });

    res.status(200).json({ message: "Contribution successful", goal });
  } catch (error: any) {
    res.status(500).json({ message: 'Failed to contribute to goal: ' + error.message });
  }
};
