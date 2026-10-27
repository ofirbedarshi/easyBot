-- easyBot: drop retired ownerGoal fields; keep firstTestedAt.
-- Mirrors emptyProfile() in src/profile.js. Do not apply from this change.

update public.easybot_business_profiles
set
  profile = (
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(
      case
        when jsonb_typeof(profile -> 'draft') = 'object'
          then jsonb_set(
            profile,
            '{draft}',
            (profile -> 'draft') - 'ownerGoal' - 'ownerGoalRequested' - 'responseLength'
          )
        else profile
      end
    ) as e
    where e.key = any (array[
      'name',
      'whatWeDo',
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
      'firstTestedAt',
      'draft'
    ])
  ),
  updated_at = now()
where
  profile ? 'ownerGoal'
  or profile ? 'ownerGoalRequested'
  or profile ? 'responseLength'
  or (
    jsonb_typeof(profile -> 'draft') = 'object'
    and (
      (profile -> 'draft') ? 'ownerGoal'
      or (profile -> 'draft') ? 'ownerGoalRequested'
      or (profile -> 'draft') ? 'responseLength'
    )
  )
  or exists (
    select 1
    from jsonb_object_keys(profile) as k
    where k <> all (array[
      'name',
      'whatWeDo',
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
      'firstTestedAt',
      'draft'
    ])
  );
