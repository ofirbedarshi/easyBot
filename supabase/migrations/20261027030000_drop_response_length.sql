-- easyBot: drop retired responseLength from stored profiles.
-- Mirrors emptyProfile() in src/profile.js. Do not apply from this change.

update public.easybot_business_profiles
set
  profile = (
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(
      case
        when jsonb_typeof(profile -> 'draft') = 'object'
          then jsonb_set(profile, '{draft}', (profile -> 'draft') - 'responseLength')
        else profile
      end
    ) as e
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
      'priceDisclosure',
      'openingMessage',
      'approvedAt',
      'draft'
    ])
  ),
  updated_at = now()
where
  profile ? 'responseLength'
  or (
    jsonb_typeof(profile -> 'draft') = 'object'
    and (profile -> 'draft') ? 'responseLength'
  )
  or exists (
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
      'priceDisclosure',
      'openingMessage',
      'approvedAt',
      'draft'
    ])
  );
