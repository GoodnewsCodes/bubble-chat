import { Request, Response } from 'express';
import { Template } from '../models/template';

// ─── GET /api/v1/templates ───────────────────────────────────────────────────
export const getTemplates = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const type = req.query.type as string | undefined;
    const filter: any = {
      $or: [{ user_id: userId }, { isDefault: true }],
    };
    if (type) filter.type = type;

    const templates = await Template.find(filter)
      .sort({ isDefault: -1, usageCount: -1, createdAt: -1 })
      .lean();

    res.status(200).json({ templates });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to fetch templates', error: err.message });
  }
};

// ─── POST /api/v1/templates ──────────────────────────────────────────────────
export const createTemplate = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { type, title, description, content, tags } = req.body;
    if (!type || !title) return res.status(400).json({ message: 'type and title are required' });

    const template = await Template.create({
      user_id: userId,
      type,
      title,
      description,
      content: content || {},
      tags: tags || [],
    });

    res.status(201).json({ message: 'Template created', template });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to create template', error: err.message });
  }
};

// ─── PUT /api/v1/templates/:id ───────────────────────────────────────────────
export const updateTemplate = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { title, description, content, tags } = req.body;
    const template = await Template.findOneAndUpdate(
      { _id: req.params.id, user_id: userId },
      { title, description, content, tags },
      { returnDocument: 'after' }
    );

    if (!template) return res.status(404).json({ message: 'Template not found' });
    res.status(200).json({ message: 'Template updated', template });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to update template', error: err.message });
  }
};

// ─── POST /api/v1/templates/:id/use ─────────────────────────────────────────
export const useTemplate = async (req: Request, res: Response): Promise<any> => {
  try {
    const template = await Template.findByIdAndUpdate(
      req.params.id,
      { $inc: { usageCount: 1 } },
      { returnDocument: 'after' }
    );
    if (!template) return res.status(404).json({ message: 'Template not found' });
    res.status(200).json({ template });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to use template', error: err.message });
  }
};

// ─── DELETE /api/v1/templates/:id ───────────────────────────────────────────
export const deleteTemplate = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const template = await Template.findOneAndDelete({
      _id: req.params.id,
      user_id: userId,
      isDefault: false,
    });

    if (!template) return res.status(404).json({ message: 'Template not found or is a system default' });
    res.status(200).json({ message: 'Template deleted' });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to delete template', error: err.message });
  }
};

// ─── Seed default templates (called on startup if none exist) ─────────────────
export const seedDefaultTemplates = async (systemUserId: string): Promise<void> => {
  const count = await Template.countDocuments({ isDefault: true });
  if (count > 0) return;

  const defaults = [
    {
      user_id: systemUserId,
      type: 'meeting',
      title: 'Weekly Team Sync',
      description: 'Standard weekly check-in agenda',
      isDefault: true,
      content: {
        agenda: [
          'Team updates (5 min)',
          'Blockers & challenges (10 min)',
          'Priorities for the week (10 min)',
          'Action items wrap-up (5 min)',
        ],
        duration: 30,
      },
    },
    {
      user_id: systemUserId,
      type: 'meeting',
      title: 'Project Kickoff',
      description: 'Project kickoff meeting structure',
      isDefault: true,
      content: {
        agenda: [
          'Project overview & goals',
          'Team introductions',
          'Roles & responsibilities',
          'Timeline & milestones',
          'Communication norms',
          'Next steps & action items',
        ],
        duration: 60,
      },
    },
    {
      user_id: systemUserId,
      type: 'task',
      title: 'Weekly Review',
      description: 'End-of-week review checklist',
      isDefault: true,
      content: {
        checklist: [
          'Review completed tasks',
          'Identify incomplete items',
          'Set priorities for next week',
          'Send team updates',
        ],
      },
    },
    {
      user_id: systemUserId,
      type: 'document',
      title: 'Project Brief',
      description: 'Template for starting a new project',
      isDefault: true,
      content: {
        sections: [
          { title: 'Overview', placeholder: 'Describe the project in 2-3 sentences...' },
          { title: 'Goals', placeholder: 'List 3-5 measurable outcomes...' },
          { title: 'Scope', placeholder: 'What is in scope? What is explicitly out of scope?' },
          { title: 'Timeline', placeholder: 'Key milestones and deadlines...' },
          { title: 'Stakeholders', placeholder: 'Who is involved and in what roles?' },
        ],
      },
    },
  ];

  await Template.insertMany(defaults);
  // console.log('✅ Default templates seeded');
};
