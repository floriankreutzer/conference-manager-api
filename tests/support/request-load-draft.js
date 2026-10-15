export function requestLoadDraft({ title = 'Synthetic load request', startsAt = '2026-11-04T09:00:00.000Z',
  configurationRevisions = { organization: 1, locations: 1, catalogue: 1, bookingPolicies: 1, costAllocation: 1 } } = {}) {
  return {
    title, roomId: 'room', startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    internalParticipants: 2, externalParticipants: 0, serviceIds: [], equipmentIds: [],
    catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
    dietaryRequirements: null, specialRequirements: null, allocations: [], configurationRevisions,
  };
}
