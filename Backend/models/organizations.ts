import mongoose, { Document, Schema } from 'mongoose';

export interface IOrganization extends Document {
    name: string;
    industry?: string;
    size?: string;
    owner: mongoose.Types.ObjectId;
    description?: string;
    pineconeNamespace?: string;
    inviteCode: string;
    website?: string;
    logo?: string;
    allowMembersToShareInvite?: boolean;
    emailTranscriptsToMembers?: boolean;
    isVerified: boolean;
    timezone: string;                 // e.g. 'Africa/Lagos', 'America/New_York'
    brainSeeded: boolean;             // true after admin completes "Seed the Brain"
    brainSeedCompletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationSchema: Schema<IOrganization> = new Schema(
    {
        name: { type: String, required: true, trim: true },
        industry: { type: String, trim: true },
        size: { type: String, enum: ['solo', '2-10', '11-50', '51-200', '201-500', '500+'] },
        owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        description: { type: String, default: '' },
        pineconeNamespace: { type: String, unique: true, sparse: true },
        inviteCode: { type: String, unique: true, required: true },
        website: { type: String, trim: true },
        logo: { type: String, default: '' },
        allowMembersToShareInvite: { type: Boolean, default: true },
        emailTranscriptsToMembers: { type: Boolean, default: true },
        isVerified: { type: Boolean, default: false },
        timezone: { type: String, default: 'UTC' },
        brainSeeded: { type: Boolean, default: false },
        brainSeedCompletedAt: { type: Date },
    },
    { timestamps: true }
);

export const Organization = mongoose.model<IOrganization>('Organization', OrganizationSchema);
