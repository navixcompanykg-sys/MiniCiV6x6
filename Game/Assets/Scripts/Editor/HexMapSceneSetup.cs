using Civa.Map;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Civa.Map.EditorTools
{
    /// <summary>
    /// One-off setup: creates (or updates) a HexMapView GameObject in SampleScene,
    /// generates the map immediately, and frames it with the main camera, so the
    /// generator's output is visible as soon as the scene is opened.
    /// Run via: Unity.exe -batchmode -projectPath <project> -executeMethod Civa.Map.EditorTools.HexMapSceneSetup.Run -quit
    /// Also available from the Editor menu: Civa/Map/Setup Hex Map In Scene.
    /// </summary>
    public static class HexMapSceneSetup
    {
        const string ScenePath = "Assets/Scenes/SampleScene.unity";
        const string ShaderPath = "Assets/Shaders/VertexColorUnlit.shader";
        const string MaterialPath = "Assets/Materials/HexMapMaterial.mat";

        [MenuItem("Civa/Map/Setup Hex Map In Scene")]
        public static void Run()
        {
            var scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);

            var material = LoadOrCreateMaterial();

            var go = GameObject.Find("HexMap");
            if (go == null)
                go = new GameObject("HexMap");

            var view = go.GetComponent<HexMapView>();
            if (view == null)
                view = go.AddComponent<HexMapView>();

            var so = new SerializedObject(view);
            so.FindProperty("material").objectReferenceValue = material;
            so.ApplyModifiedPropertiesWithoutUndo();

            view.Generate();

            FrameCamera(view.MeshBounds);

            EditorUtility.SetDirty(go);
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene);

            Debug.Log($"[HexMapSceneSetup] Done. Map bounds: {view.MeshBounds}, regions: {view.Map.Regions.Length}");
        }

        static Material LoadOrCreateMaterial()
        {
            var mat = AssetDatabase.LoadAssetAtPath<Material>(MaterialPath);
            if (mat != null) return mat;

            var shader = AssetDatabase.LoadAssetAtPath<Shader>(ShaderPath);
            if (shader == null) shader = Shader.Find("Civa/VertexColorUnlit");
            if (shader == null)
            {
                Debug.LogError("[HexMapSceneSetup] Could not find Civa/VertexColorUnlit shader.");
                return null;
            }

            mat = new Material(shader) { name = "HexMapMaterial" };
            System.IO.Directory.CreateDirectory("Assets/Materials");
            AssetDatabase.CreateAsset(mat, MaterialPath);
            AssetDatabase.SaveAssets();
            return mat;
        }

        static void FrameCamera(Bounds bounds)
        {
            var cam = Camera.main;
            if (cam == null) return;

            cam.orthographic = true;
            cam.transform.position = new Vector3(bounds.center.x, bounds.center.y, cam.transform.position.z);

            // cam.aspect isn't reliable when run headless (no Game view has rendered yet),
            // so size off the larger extent directly instead of dividing by aspect —
            // errs toward showing a bit more map rather than cropping it.
            cam.orthographicSize = Mathf.Max(bounds.extents.x, bounds.extents.y) * 1.35f;

            EditorUtility.SetDirty(cam);
        }
    }
}
