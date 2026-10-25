-- easyBot: keep only current top-level business profile keys.
-- Retired fields are removed; the list mirrors emptyProfile() in src/profile.js.

update public.easybot_business_profiles
set
  profile = (
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(profile) as e
    where e.key = any (array[
      'name',
      'whatWeDo',
      'ownerGoal',
      'ownerGoalRequested',
      'services',
      'hours',
      'locationOrArea',
      'commonQuestions',
      'informationToCollect',
      'unknowns',
      'otherFacts',
      'tone',
      'responseLength',
      'priceDisclosure',
      'assistantName',
      'openingMessage',
      'approvedAt',
      'reviewedDraftKey',
      'draft'
    ])
  ),
  updated_at = now()
where exists (
  select 1
  from jsonb_object_keys(profile) as k
  where k <> all (array[
    'name',
    'whatWeDo',
    'ownerGoal',
    'ownerGoalRequested',
    'services',
    'hours',
    'locationOrArea',
    'commonQuestions',
    'informationToCollect',
    'unknowns',
    'otherFacts',
    'tone',
    'responseLength',
    'priceDisclosure',
    'assistantName',
    'openingMessage',
    'approvedAt',
    'reviewedDraftKey',
    'draft'
  ])
);
