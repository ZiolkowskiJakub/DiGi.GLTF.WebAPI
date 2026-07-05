using Microsoft.Extensions.DependencyInjection;
using System.Threading.Tasks;

namespace DiGi.GLTF.WebAPI
{
    public static partial class Modify
    {
        /// <summary>
        /// Initializes the GLTF Web API services required by its controllers.
        /// <para>This method is the extension initialization entry point invoked by the hosting service; the controllers currently require no additional services.</para>
        /// </summary>
        /// <param name="serviceCollection">The <see cref="Microsoft.Extensions.DependencyInjection.IServiceCollection" /> to add services to.</param>
        /// <returns>A <see cref="Task"/> representing the asynchronous operation.</returns>
        public static async Task InitializeAsync(this IServiceCollection serviceCollection)
        {
            if (serviceCollection is null)
            {
                return;
            }

            await Task.CompletedTask;
        }
    }
}
