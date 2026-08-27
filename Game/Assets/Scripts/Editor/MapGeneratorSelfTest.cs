using System;
using System.Collections.Generic;
using System.Linq;
using Civa.Map;
using UnityEditor;
using UnityEngine;

namespace Civa.Map.EditorTools
{
    /// <summary>
    /// Validates HexMapGenerator invariants across many seeds. Run via
    /// Unity.exe -batchmode -projectPath <project> -executeMethod Civa.Map.EditorTools.MapGeneratorSelfTest.RunFromCommandLine -quit
    /// Also available from the Editor menu: Civa/Map/Run Generator Self-Test.
    /// </summary>
    public static class MapGeneratorSelfTest
    {
        [MenuItem("Civa/Map/Run Generator Self-Test")]
        public static void RunFromCommandLine()
        {
            var failures = new List<string>();
            const int seedsToTest = 200;

            for (int seed = 0; seed < seedsToTest; seed++)
            {
                var map = HexMapGenerator.Generate(seed);
                CheckMap(map, seed, failures);
            }

            if (failures.Count == 0)
            {
                Debug.Log($"[MapGeneratorSelfTest] PASSED — {seedsToTest} seeds, all invariants hold.");
            }
            else
            {
                Debug.LogError($"[MapGeneratorSelfTest] FAILED — {failures.Count} issue(s):\n" + string.Join("\n", failures));
            }
        }

        static void CheckMap(MapData map, int seed, List<string> failures)
        {
            void Fail(string msg) => failures.Add($"seed {seed}: {msg}");

            // 36 regions total, correct per-type counts (ТЗ 1.1)
            if (map.Regions.Length != 36) Fail($"expected 36 regions, got {map.Regions.Length}");

            var counts = map.Regions.GroupBy(r => r.Type).ToDictionary(g => g.Key, g => g.Count());
            CheckCount(counts, RegionType.Land, 12, Fail);
            CheckCount(counts, RegionType.NeutralCity, 4, Fail);
            CheckCount(counts, RegionType.Desert, 2, Fail);
            CheckCount(counts, RegionType.OpenSea, 12, Fail);
            CheckCount(counts, RegionType.Coast, 3, Fail);
            CheckCount(counts, RegionType.Island, 3, Fail);

            // Every hex belongs to exactly one region, 24x18 total, 12 hexes per region
            if (map.HexToRegion.Count != MapData.Width * MapData.Height)
                Fail($"expected {MapData.Width * MapData.Height} mapped hexes, got {map.HexToRegion.Count}");
            foreach (var region in map.Regions)
                if (region.Hexes.Count != MapData.RegionSizeX * MapData.RegionSizeY)
                    Fail($"region {region.Id} has {region.Hexes.Count} hexes, expected {MapData.RegionSizeX * MapData.RegionSizeY}");

            // Resources: only settleable regions carry them, always exactly 3 (ТЗ 1.2 / 9)
            foreach (var region in map.Regions)
            {
                bool shouldHaveResources = RegionRules.GetsResources(region.Type);
                if (shouldHaveResources && region.Resources.Count != 3)
                    Fail($"settleable region {region.Id} ({region.Type}) has {region.Resources.Count} resources, expected 3");
                if (!shouldHaveResources && region.Resources.Count != 0)
                    Fail($"non-settleable region {region.Id} ({region.Type}) has {region.Resources.Count} resources, expected 0");

                // Sea-access resources may only appear on Coast/Island
                if (region.Type == RegionType.Land)
                {
                    foreach (var res in region.Resources)
                    {
                        var def = ResourceCatalog.All.First(d => d.Type == res);
                        if (def.RequiresSeaAccess)
                            Fail($"region {region.Id} (Land) has sea-access resource {res}");
                    }
                }
            }

            // Global resource totals must match the catalog exactly
            var allPlaced = map.Regions.SelectMany(r => r.Resources).ToList();
            if (allPlaced.Count != ResourceCatalog.TotalResourceSlots)
                Fail($"total placed resources {allPlaced.Count}, expected {ResourceCatalog.TotalResourceSlots}");

            foreach (var def in ResourceCatalog.All)
            {
                int placed = allPlaced.Count(r => r == def.Type);
                if (placed != def.TotalCount)
                    Fail($"resource {def.Type}: placed {placed}, expected {def.TotalCount}");
            }
        }

        static void CheckCount(Dictionary<RegionType, int> counts, RegionType type, int expected, Action<string> fail)
        {
            counts.TryGetValue(type, out var actual);
            if (actual != expected) fail($"{type} count {actual}, expected {expected}");
        }
    }
}
