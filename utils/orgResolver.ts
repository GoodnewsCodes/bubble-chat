import { Organization, IOrganization } from '../models/organizations';
import { User, IUser } from '../models/users';

/**
 * Resolve the authoritative Organization for a user.
 *
 * Prefers the canonical user.organizationId reference. Falls back to the
 * legacy user.organization (name) field, and when the fallback succeeds it
 * opportunistically backfills user.organizationId so subsequent lookups are
 * direct findById calls.
 *
 * Returns null when the user is not mapped to any organization.
 */
export const resolveUserOrg = async (
    userOrUserId: IUser | string | { _id: any; organizationId?: any; organization?: string }
): Promise<IOrganization | null> => {
    let user: any = userOrUserId;
    if (typeof userOrUserId === 'string') {
        user = await User.findById(userOrUserId).select('organization organizationId');
        if (!user) return null;
    }

    if (user.organizationId) {
        const byId = await Organization.findById(user.organizationId);
        if (byId) return byId;
    }

    if (user.organization) {
        const byName = await Organization.findOne({ name: user.organization });
        if (byName) {
            // Opportunistic backfill — keep the canonical reference fresh.
            if (!user.organizationId || String(user.organizationId) !== String(byName._id)) {
                try {
                    await User.findByIdAndUpdate(user._id, { organizationId: byName._id });
                } catch {
                    // non-fatal — next call will retry
                }
            }
            return byName;
        }
    }

    return null;
};
